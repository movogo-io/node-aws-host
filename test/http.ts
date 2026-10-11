import { put } from '@movogo-io/service/http'
import assert from 'node:assert/strict'
import { awsHandler } from '../http.js'

// `rawBody` is read by the host at runtime; the installed host's configuration type does not
// name it yet, so the option is passed beside one it does.
const webhookConfig = { excludeBodyFromLogs: true, rawBody: true }

// One HTTP handler per process: `awsHandler` takes the first registered.

put('webhooks/*', webhookConfig, (_context, request) => ({
    body: { seen: request.body, type: typeof request.body },
}))

describe('http', () => {
    it('hands a raw-body handler the body as the string API Gateway received', async () => {
        const response = await awsHandler(
            event('{"event": "created",  "id": 7}', false),
            awsContext(),
        )

        assert.strictEqual(response.statusCode, 200)
        assert.deepStrictEqual(JSON.parse(response.body ?? ''), {
            seen: '{"event": "created",  "id": 7}',
            type: 'string',
        })
    })

    it('decodes a base64 body before handing it over', async () => {
        const response = await awsHandler(
            event(Buffer.from('{"id": 7}').toString('base64'), true),
            awsContext(),
        )

        assert.strictEqual(response.statusCode, 200)
        assert.deepStrictEqual(JSON.parse(response.body ?? ''), {
            seen: '{"id": 7}',
            type: 'string',
        })
    })

    it('hands a raw-body handler no body when none was sent', async () => {
        const response = await awsHandler(event(undefined, false), awsContext())

        assert.strictEqual(response.statusCode, 200)
        assert.deepStrictEqual(JSON.parse(response.body ?? ''), { type: 'undefined' })
    })
})

function event(body: string | undefined, isBase64Encoded: boolean) {
    return {
        version: '2.0' as const,
        routeKey: 'PUT /webhooks/{proxy+}',
        rawPath: '/webhooks/linear',
        rawQueryString: '',
        headers: { 'content-type': 'application/json' },
        cookies: {},
        queryStringParameters: {},
        pathParameters: {},
        stageVariables: {},
        requestContext: {
            accountId: '123456789012',
            apiId: 'api',
            domainName: 'issues.example.com',
            domainPrefix: 'issues',
            http: {
                method: 'PUT',
                path: '/webhooks/linear',
                protocol: 'HTTP/1.1',
                sourceIp: '192.0.2.1',
                userAgent: 'test/1',
            },
            requestId: 'req-1',
            routeKey: 'PUT /webhooks/{proxy+}',
            stage: '$default',
            time: '11/Oct/2026:10:00:00 +0000',
            timeEpoch: 1_791_712_800_000,
        },
        ...(body !== undefined && { body }),
        isBase64Encoded,
    }
}

function awsContext() {
    return {
        getRemainingTimeInMillis: () => 10_000,
        functionName: 'test-issues-webhooks-linear',
        functionVersion: '$LATEST',
        invokedFunctionArn: 'arn:aws:lambda:eu-north-1:123456789012:function:test',
        memoryLimitInMB: 128,
        awsRequestId: 'aws-req-1',
        logGroupName: '/aws/lambda/test',
        logStreamName: 'stream',
        callbackWaitsForEmptyEventLoop: true,
    }
}
