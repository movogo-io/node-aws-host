import { claim } from '@movogo-io/host/attribution'
import type { ClientInfo } from '@movogo-io/host/context'
import { thrownHasStatus } from '@riddance/fetch'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { brotliDecompressSync } from 'node:zlib'
import { SnsEventTransport } from '../lib/sns.js'

type ScriptedResponse = { readonly status: number; readonly onRequest?: () => void }

describe('sns transport', () => {
    let server: Server
    let baseUrl: string
    const requests: string[] = []
    const script: ScriptedResponse[] = []
    let scripted = 0
    const warnings: { message: string; fields: { topic: string; type: string } }[] = []
    const warnSink = {
        warn: (message: string, fields: { topic: string; type: string }) => {
            warnings.push({ message, fields })
        },
    }

    before(async () => {
        server = createServer((request, response) => {
            const chunks: Buffer[] = []
            request.on('data', (chunk: Buffer) => {
                chunks.push(chunk)
            })
            request.on('end', () => {
                requests.push(Buffer.concat(chunks).toString())
                const { status, onRequest } = script[scripted++] ?? { status: 200 }
                onRequest?.()
                response.writeHead(status, { 'content-type': 'text/xml' })
                response.end(
                    status === 200
                        ? '<PublishResponse><PublishResult><MessageId>m</MessageId></PublishResult></PublishResponse>'
                        : `<ErrorResponse><Error><Code>${status}</Code></Error></ErrorResponse>`,
                )
            })
        })
        await new Promise<void>((resolve, reject) => {
            server.on('error', reject)
            server.listen(0, '127.0.0.1', resolve)
        })
        const address = server.address()
        if (!isAddressInfo(address)) {
            throw new Error('Mock SNS server has no address.')
        }
        baseUrl = `http://127.0.0.1:${address.port}`
    })

    after(async () => {
        await new Promise<void>((resolve, reject) => {
            server.close(e => {
                if (e) {
                    reject(e)
                    return
                }
                resolve()
            })
        })
    })

    beforeEach(() => {
        requests.length = 0
        script.length = 0
        scripted = 0
        warnings.length = 0
    })

    it('numbers client, attribution, emitter and encoding attributes in order', async () => {
        await transport(baseUrl).sendEvent(
            'rentals',
            'updated',
            'r1',
            { id: 'r1', pad: 'x'.repeat(8192) },
            'm1',
            new AbortController().signal,
            {
                attributes: { resource: 'rental', op: 'update' },
                attribution: { onBehalfOf: claim('u1', 'o1') },
            },
        )

        assert.strictEqual(requests.length, 1)
        const { Message, ...fields } = Object.fromEntries(new URLSearchParams(requests[0]))
        assert.deepStrictEqual(fields, {
            Version: '2010-03-31',
            Action: 'Publish',
            TopicArn: 'arn:aws:sns:eu-north-1:123456789012:deploy-test-rentals-updated',
            Subject: 'r1',
            MessageId: 'm1',
            Type: 'updated',
            ...attribute(1, 'clientId', 'c1'),
            ...attribute(2, 'operationId', 'op1'),
            ...attribute(3, 'onBehalfOfUserId', 'u1'),
            ...attribute(4, 'onBehalfOfOrg', 'o1'),
            ...attribute(5, 'resource', 'rental'),
            ...attribute(6, 'op', 'update'),
            ...attribute(7, 'content-encoding', 'br'),
        })
        assert.deepStrictEqual(
            JSON.parse(brotliDecompressSync(Buffer.from(Message ?? '', 'base64')).toString()),
            { id: 'r1', pad: 'x'.repeat(8192) },
        )
    })

    it('sends only the client attributes without extras', async () => {
        await transport(baseUrl).sendEvent(
            'rentals',
            'updated',
            'r1',
            { id: 'r1' },
            'm1',
            new AbortController().signal,
        )

        assert.strictEqual(requests.length, 1)
        assert.deepStrictEqual(Object.fromEntries(new URLSearchParams(requests[0])), {
            Version: '2010-03-31',
            Action: 'Publish',
            TopicArn: 'arn:aws:sns:eu-north-1:123456789012:deploy-test-rentals-updated',
            Message: '{"id":"r1"}',
            Subject: 'r1',
            MessageId: 'm1',
            Type: 'updated',
            ...attribute(1, 'clientId', 'c1'),
            ...attribute(2, 'operationId', 'op1'),
        })
    })

    it('keeps the request id a client sent off the wire', async () => {
        await transport(baseUrl, {
            clientId: 'c1',
            clientIp: '1.2.3.4',
            clientPort: 56,
            operationId: 'op1',
            userAgent: 'ua',
            clientRequestId: 'their-request-id',
        }).sendEvent('rentals', 'updated', 'r1', { id: 'r1' }, 'm1', new AbortController().signal)

        assert.strictEqual(requests.length, 1)
        assert.deepStrictEqual(Object.fromEntries(new URLSearchParams(requests[0])), {
            Version: '2010-03-31',
            Action: 'Publish',
            TopicArn: 'arn:aws:sns:eu-north-1:123456789012:deploy-test-rentals-updated',
            Message: '{"id":"r1"}',
            Subject: 'r1',
            MessageId: 'm1',
            Type: 'updated',
            ...attribute(1, 'clientId', 'c1'),
            ...attribute(2, 'clientIp', '1.2.3.4'),
            'MessageAttributes.entry.3.Name': 'clientPort',
            'MessageAttributes.entry.3.Value.DataType': 'Number',
            'MessageAttributes.entry.3.Value.StringValue': '56',
            ...attribute(4, 'operationId', 'op1'),
            ...attribute(5, 'userAgent', 'ua'),
        })
    })

    it('retries a throttled publish', async () => {
        script.push({ status: 429 }, { status: 200 })

        await transport(baseUrl).sendEvent(
            'rentals',
            'updated',
            'r1',
            { id: 'r1' },
            'm1',
            new AbortController().signal,
        )

        assert.strictEqual(requests.length, 2)
        assert.strictEqual(requests[0], requests[1])
    })

    it('does not retry a rejected publish', async () => {
        script.push({ status: 400 })

        await assert.rejects(
            transport(baseUrl).sendEvent(
                'rentals',
                'updated',
                'r1',
                { id: 'r1' },
                'm1',
                new AbortController().signal,
            ),
            (e: unknown) => thrownHasStatus(e, 400),
        )

        assert.strictEqual(requests.length, 1)
    })

    it('gives up after five failed attempts', async () => {
        script.push(
            { status: 500 },
            { status: 503 },
            { status: 500 },
            { status: 502 },
            { status: 500 },
        )

        await assert.rejects(
            transport(baseUrl).sendEvent(
                'rentals',
                'updated',
                'r1',
                { id: 'r1' },
                'm1',
                new AbortController().signal,
            ),
            (e: unknown) => thrownHasStatus(e, 500),
        )

        assert.strictEqual(requests.length, 5)
    })

    it('stops retrying when the invocation is aborted', async () => {
        const controller = new AbortController()
        script.push({
            status: 500,
            onRequest: () => {
                controller.abort()
            },
        })

        await assert.rejects(
            transport(baseUrl).sendEvent(
                'rentals',
                'updated',
                'r1',
                { id: 'r1' },
                'm1',
                controller.signal,
            ),
            (e: unknown) => (e as { name?: string }).name === 'AbortError',
        )

        assert.strictEqual(requests.length, 1)
    })

    it('warns and drops the event when the topic is missing', async () => {
        script.push({ status: 404 })

        await transport(baseUrl).sendEvent(
            'rentals',
            'updated',
            'r1',
            { id: 'r1', secret: 'never logged' },
            'm1',
            new AbortController().signal,
        )

        assert.strictEqual(requests.length, 1)
        assert.deepStrictEqual(warnings, [
            {
                message: 'Topic not found; event dropped.',
                fields: { topic: 'rentals', type: 'updated' },
            },
        ])
    })

    function transport(url: string, client?: ClientInfo) {
        return new SnsEventTransport(
            client ?? { clientId: 'c1', operationId: 'op1' },
            {
                AWS_REGION: 'eu-north-1',
                AWS_ACCESS_KEY_ID: 'x',
                AWS_SECRET_ACCESS_KEY: 'y',
                AWS_LAMBDA_FUNCTION_NAME: 'deploy-test-svc-fn',
            },
            { packageName: 'svc', fileName: 'fn', revision: undefined },
            'arn:aws:lambda:eu-north-1:123456789012:function:deploy-test-svc-fn',
            warnSink,
            { baseUrl: url, retryDelayBaseMs: 1 },
        )
    }
})

function attribute(index: number, name: string, value: string) {
    return {
        [`MessageAttributes.entry.${index}.Name`]: name,
        [`MessageAttributes.entry.${index}.Value.DataType`]: 'String',
        [`MessageAttributes.entry.${index}.Value.StringValue`]: value,
    }
}

function isAddressInfo(address: AddressInfo | string | null): address is AddressInfo {
    return typeof address === 'object' && address !== null
}
