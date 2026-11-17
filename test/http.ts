import { put } from '@movogo-io/service/http'
import assert from 'node:assert/strict'
import { awsHandler } from '../http.js'

// One HTTP handler per process: `awsHandler` takes the first registered.

put('webhooks/*', { rawBody: true }, (context, request) => ({
    body: {
        seen: request.body,
        type: typeof request.body,
        step: decodeURIComponent(request.url.pathStepAt(1)),
        search: request.url.search,
        pathname: request.url.pathname,
        headerNames: Object.keys(request.headers),
        cookie: request.headers.cookie,
        gatewaySourceIp: request.headers['x-gateway-source-ip'],
        ip: context.client?.ip,
    },
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
            step: 'linear',
            search: '',
            pathname: '/webhooks/linear',
            headerNames: ['content-type', 'x-gateway-source-ip'],
            gatewaySourceIp: '192.0.2.1',
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
            step: 'linear',
            search: '',
            pathname: '/webhooks/linear',
            headerNames: ['content-type', 'x-gateway-source-ip'],
            gatewaySourceIp: '192.0.2.1',
        })
    })

    it('hands a raw-body handler no body when none was sent', async () => {
        const response = await awsHandler(event(undefined, false), awsContext())

        assert.strictEqual(response.statusCode, 200)
        assert.deepStrictEqual(JSON.parse(response.body ?? ''), {
            type: 'undefined',
            step: 'linear',
            search: '',
            pathname: '/webhooks/linear',
            headerNames: ['content-type', 'x-gateway-source-ip'],
            gatewaySourceIp: '192.0.2.1',
        })
    })

    it('hands the cookies of a payload 2.0 event over as one cookie header', async () => {
        const response = await awsHandler(
            {
                ...event(undefined, false),
                headers: { 'content-type': 'application/json', Cookie: 'a=1' },
                cookies: ['__Host-session=s1', 'b=2'],
            },
            awsContext(),
        )

        assert.strictEqual(response.statusCode, 200)
        assert.deepStrictEqual(JSON.parse(response.body ?? ''), {
            type: 'undefined',
            step: 'linear',
            search: '',
            pathname: '/webhooks/linear',
            cookie: 'a=1; __Host-session=s1; b=2',
            headerNames: ['content-type', 'x-gateway-source-ip', 'cookie'],
            gatewaySourceIp: '192.0.2.1',
        })
    })

    it('hands over the cookies of a payload 2.0 event that has no cookie header', async () => {
        const response = await awsHandler(
            { ...event(undefined, false), cookies: ['__Host-session=s1', 'b=2'] },
            awsContext(),
        )

        assert.strictEqual(response.statusCode, 200)
        assert.deepStrictEqual(JSON.parse(response.body ?? ''), {
            type: 'undefined',
            step: 'linear',
            search: '',
            pathname: '/webhooks/linear',
            cookie: '__Host-session=s1; b=2',
            headerNames: ['content-type', 'x-gateway-source-ip', 'cookie'],
            gatewaySourceIp: '192.0.2.1',
        })
    })

    it('adds no cookie header for an empty cookies list', async () => {
        const response = await awsHandler({ ...event(undefined, false), cookies: [] }, awsContext())

        assert.strictEqual(response.statusCode, 200)
        assert.deepStrictEqual(JSON.parse(response.body ?? ''), {
            type: 'undefined',
            step: 'linear',
            search: '',
            pathname: '/webhooks/linear',
            headerNames: ['content-type', 'x-gateway-source-ip'],
            gatewaySourceIp: '192.0.2.1',
        })
    })

    it('handles a REST API test invocation without headers', async () => {
        // API Gateway's test invocation sends headers: null.
        // eslint-disable-next-line unicorn/no-null
        const response = await awsHandler(restEvent(null, '192.0.2.2'), awsContext())

        assert.strictEqual(response.statusCode, 200)
        assert.deepStrictEqual(JSON.parse(response.body ?? ''), {
            type: 'undefined',
            step: 'linear',
            search: '',
            pathname: '/webhooks/linear',
            headerNames: ['x-gateway-source-ip'],
            gatewaySourceIp: '192.0.2.2',
        })
    })

    it('replaces a gateway source address the client sent, and keeps the client address from X-Forwarded-For', async () => {
        const response = await awsHandler(
            {
                ...event(undefined, false),
                headers: {
                    'content-type': 'application/json',
                    'x-gateway-source-ip': '198.51.100.7',
                    'x-forwarded-for': '203.0.113.9',
                },
            },
            awsContext(),
        )

        assert.strictEqual(response.statusCode, 200)
        assert.deepStrictEqual(JSON.parse(response.body ?? ''), {
            type: 'undefined',
            step: 'linear',
            search: '',
            pathname: '/webhooks/linear',
            headerNames: ['content-type', 'x-forwarded-for', 'x-gateway-source-ip'],
            gatewaySourceIp: '192.0.2.1',
            ip: '203.0.113.9',
        })
    })

    it('replaces a gateway source address in any case on a REST API event', async () => {
        const response = await awsHandler(
            restEvent(
                { 'X-Gateway-Source-Ip': '198.51.100.7', 'x-gateway-source-ip': '198.51.100.8' },
                '192.0.2.2',
            ),
            awsContext(),
        )

        assert.strictEqual(response.statusCode, 200)
        assert.deepStrictEqual(JSON.parse(response.body ?? ''), {
            type: 'undefined',
            step: 'linear',
            search: '',
            pathname: '/webhooks/linear',
            headerNames: ['x-gateway-source-ip'],
            gatewaySourceIp: '192.0.2.2',
        })
    })

    it('removes a gateway source address the client sent when API Gateway gave none', async () => {
        const response = await awsHandler(
            restEvent({ 'x-gateway-source-ip': '198.51.100.7' }, undefined),
            awsContext(),
        )

        assert.strictEqual(response.statusCode, 200)
        assert.deepStrictEqual(JSON.parse(response.body ?? ''), {
            type: 'undefined',
            step: 'linear',
            search: '',
            pathname: '/webhooks/linear',
            headerNames: [],
        })
    })

    it('keeps a step that API Gateway decoded to a reserved character whole', async () => {
        const response = await awsHandler(
            event(undefined, false, '/webhooks/P#A?%\\x', 'supplierId=S'),
            awsContext(),
        )

        assert.strictEqual(response.statusCode, 200)
        assert.deepStrictEqual(JSON.parse(response.body ?? ''), {
            type: 'undefined',
            step: 'P#A?%\\x',
            search: '?supplierId=S',
            pathname: '/webhooks/P%23A%3F%25%5Cx',
            headerNames: ['content-type', 'x-gateway-source-ip'],
            gatewaySourceIp: '192.0.2.1',
        })
    })

    it('keeps a tab, a line break, a trailing space and a stray percent in a step', async () => {
        const response = await awsHandler(
            event(undefined, false, '/webhooks/a\tb\nc%zz '),
            awsContext(),
        )

        assert.strictEqual(response.statusCode, 200)
        assert.deepStrictEqual(JSON.parse(response.body ?? ''), {
            type: 'undefined',
            step: 'a\tb\nc%zz ',
            search: '',
            pathname: '/webhooks/a%09b%0Ac%25zz%20',
            headerNames: ['content-type', 'x-gateway-source-ip'],
            gatewaySourceIp: '192.0.2.1',
        })
    })

    it('keeps a # in the last step when there is no query', async () => {
        const response = await awsHandler(event(undefined, false, '/webhooks/P#A'), awsContext())

        assert.strictEqual(response.statusCode, 200)
        assert.deepStrictEqual(JSON.parse(response.body ?? ''), {
            type: 'undefined',
            step: 'P#A',
            search: '',
            pathname: '/webhooks/P%23A',
            headerNames: ['content-type', 'x-gateway-source-ip'],
            gatewaySourceIp: '192.0.2.1',
        })
    })

    it('lets a .. step collapse with the step before it and drops a lone . step', async () => {
        const response = await awsHandler(
            event(undefined, false, '/webhooks/./a/../linear'),
            awsContext(),
        )

        assert.strictEqual(response.statusCode, 200)
        assert.deepStrictEqual(JSON.parse(response.body ?? ''), {
            type: 'undefined',
            step: 'linear',
            search: '',
            pathname: '/webhooks/linear',
            headerNames: ['content-type', 'x-gateway-source-ip'],
            gatewaySourceIp: '192.0.2.1',
        })
    })

    it('hands over the path of a REST API event as API Gateway gave it', async () => {
        const response = await awsHandler(
            restEvent({}, '192.0.2.2', '/webhooks/P%23A'),
            awsContext(),
        )

        assert.strictEqual(response.statusCode, 200)
        assert.deepStrictEqual(JSON.parse(response.body ?? ''), {
            type: 'undefined',
            step: 'P#A',
            search: '',
            pathname: '/webhooks/P%23A',
            headerNames: ['x-gateway-source-ip'],
            gatewaySourceIp: '192.0.2.2',
        })
    })

    it('hands over a step API Gateway decoded to a space or a letter beyond ASCII as decoded', async () => {
        const response = await awsHandler(event(undefined, false, '/webhooks/a bæ'), awsContext())

        assert.strictEqual(response.statusCode, 200)
        assert.deepStrictEqual(JSON.parse(response.body ?? ''), {
            type: 'undefined',
            step: 'a bæ',
            search: '',
            pathname: '/webhooks/a%20b%C3%A6',
            headerNames: ['content-type', 'x-gateway-source-ip'],
            gatewaySourceIp: '192.0.2.1',
        })
    })
})

function restEvent(
    headers: { [key: string]: string } | null,
    sourceIp: string | undefined,
    path = '/webhooks/linear',
) {
    return {
        resource: '/webhooks/{proxy+}',
        path,
        httpMethod: 'PUT',
        requestContext: {
            resourcePath: '/webhooks/{proxy+}',
            httpMethod: 'PUT',
            domainName: 'issues.example.com',
            path,
            protocol: 'HTTP/1.1',
            stage: 'prod',
            requestId: 'req-1',
            identity: { accountId: '123456789012', sourceIp, userAgent: 'test/1' },
        },
        headers,
        multiValueHeaders: {},
        multiValueQueryStringParameters: {},
        pathParameters: {},
        stageVariables: {},
        isBase64Encoded: false,
    }
}

function event(
    body: string | undefined,
    isBase64Encoded: boolean,
    rawPath = '/webhooks/linear',
    rawQueryString = '',
) {
    return {
        version: '2.0' as const,
        routeKey: 'PUT /webhooks/{proxy+}',
        rawPath,
        rawQueryString,
        headers: { 'content-type': 'application/json' },
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
                path: rawPath,
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
