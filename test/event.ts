import { setMeta } from '@movogo-io/host/registry'
import { on } from '@movogo-io/service/event'
import assert from 'node:assert/strict'
import { brotliCompressSync } from 'node:zlib'
import { awsHandler } from '../event.js'

// One test file owns the registry: mocha's parallel workers isolate files, and the host
// delivers every record of a batch to the first registered handler.
setMeta('svc', 'fn', undefined, undefined)

const received: {
    subject: string
    operationId: string | undefined
    onBehalfOf: { userId: string; org?: string } | undefined
}[] = []
const payloads: unknown[] = []

on('topic', 'type', (context, subject, event) => {
    if (subject === 'error') {
        throw new Error('Handler failed on purpose.')
    }
    received.push({
        subject,
        operationId: context.operationId,
        onBehalfOf: context.attribution.onBehalfOf,
    })
    payloads.push(event)
})

describe('event', () => {
    before(() => {
        // Without a region the transport falls back to one that only rejects, so no record
        // emits anything; the handlers under test never emit.
        delete process.env.AWS_REGION
    })

    beforeEach(() => {
        received.length = 0
        payloads.length = 0
    })

    it('gives each record its own context with the client and attribution it carried', async () => {
        await awsHandler(
            {
                Records: [
                    record('s1', '{"n":1}', { operationId: { Type: 'String', Value: 'op1' } }),
                    record('s2', '{"n":2}', {
                        operationId: { Type: 'String', Value: 'op2' },
                        onBehalfOfUserId: { Type: 'String', Value: 'u2' },
                        onBehalfOfOrg: { Type: 'String', Value: 'o2' },
                    }),
                ],
            },
            awsContext(),
        )

        assert.deepStrictEqual(received, [
            { subject: 's1', operationId: 'op1', onBehalfOf: undefined },
            { subject: 's2', operationId: 'op2', onBehalfOf: { userId: 'u2', org: 'o2' } },
        ])
    })

    it('decompresses a brotli-compressed body', async () => {
        const body = brotliCompressSync(Buffer.from('{"large":true}', 'utf-8')).toString('base64')
        await awsHandler(
            {
                Records: [
                    record('compressed', body, {
                        'content-encoding': { Type: 'String', Value: 'br' },
                    }),
                ],
            },
            awsContext(),
        )

        assert.deepStrictEqual(payloads, [{ large: true }])
    })

    it('runs the other records when one handler fails and rejects the batch', async () => {
        await assert.rejects(
            awsHandler(
                {
                    Records: [
                        record('error', '{}', {}),
                        record('fine', '{}', { operationId: { Type: 'String', Value: 'op3' } }),
                    ],
                },
                awsContext(),
            ),
            AggregateError,
        )

        assert.deepStrictEqual(received, [
            { subject: 'fine', operationId: 'op3', onBehalfOf: undefined },
        ])
    })

    it('runs the other records when one is malformed and rejects the batch', async () => {
        await assert.rejects(
            awsHandler(
                {
                    Records: [
                        record('malformed', 'not json', {}),
                        record('fine', '{}', { operationId: { Type: 'String', Value: 'op4' } }),
                    ],
                },
                awsContext(),
            ),
            AggregateError,
        )

        assert.deepStrictEqual(received, [
            { subject: 'fine', operationId: 'op4', onBehalfOf: undefined },
        ])
    })
})

function record(
    subject: string,
    message: string,
    attributes: { [name: string]: { Type: string; Value: string } },
) {
    return {
        EventVersion: '1.0',
        EventSubscriptionArn: 'arn:aws:sns:eu-north-1:123456789012:p-topic:sub',
        EventSource: 'aws:sns',
        Sns: {
            SignatureVersion: '1',
            Timestamp: '2026-10-01T10:00:00.000Z',
            Signature: 'signature',
            SigningCertUrl: 'https://sns.eu-north-1.amazonaws.com/cert.pem',
            MessageId: `message-${subject}`,
            Message: message,
            MessageAttributes: attributes,
            Type: 'Notification',
            UnsubscribeUrl: 'https://sns.eu-north-1.amazonaws.com/?Action=Unsubscribe',
            TopicArn: 'arn:aws:sns:eu-north-1:123456789012:p-topic',
            Subject: subject,
        },
    }
}

function awsContext() {
    return {
        getRemainingTimeInMillis: () => 150_000,
        functionName: 'p-svc-fn',
        functionVersion: '$LATEST',
        invokedFunctionArn: 'arn:aws:lambda:eu-north-1:123456789012:function:p-svc-fn',
        memoryLimitInMB: 1024,
        awsRequestId: 'request',
        logGroupName: '/aws/lambda/p-svc-fn',
        logStreamName: 'stream',
        callbackWaitsForEmptyEventLoop: false,
    }
}
