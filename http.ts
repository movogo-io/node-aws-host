import { clientFromHeaders, executeRequest } from '@movogo-io/host/http'
import { Json, measure } from '@movogo-io/host/lib/http'
import { getHandlers } from '@movogo-io/host/registry'
import { AwsContext, createAwsContext } from './context.js'

export { setMeta } from '@movogo-io/host/registry'
export * from '@movogo-io/service/http'

type HttpResponse = {
    statusCode: string | number
    headers?: { [key: string]: string }
    multiValueHeaders?: { [key: string]: string[] }
    body?: string
    isBase64Encoded?: boolean
}

type CommonRequestEvent = {
    pathParameters: { [key: string]: string }
    stageVariables: { [key: string]: string }
    body?: string
    isBase64Encoded: boolean
}

type RestRequestEvent = {
    resource: string
    path: string
    httpMethod: string
    requestContext: {
        resourcePath: string
        httpMethod: string
        domainName: string
        path: string
        protocol: string
        stage: string
        requestId: string
        identity: {
            accountId: string
            sourceIp?: string
            userAgent: string
        }
    }
    headers: { [key: string]: string } | null
    multiValueHeaders: { [key: string]: string[] }
    multiValueQueryStringParameters: { [key: string]: string[] }
} & CommonRequestEvent

type HttpRequestEvent = {
    version: '2.0'
    routeKey: string
    rawPath: string
    rawQueryString: string
    headers: { [key: string]: string }
    cookies?: string[]
    queryStringParameters: { [key: string]: string }
    requestContext: {
        accountId: string
        apiId: string
        domainName: string
        domainPrefix: string
        http: {
            method: string
            path: string
            protocol: string
            sourceIp?: string
            userAgent: string
        }
        requestId: string
        routeKey: string
        stage: string
        time: string
        timeEpoch: number
    }
} & CommonRequestEvent

type RequestEvent = HttpRequestEvent | RestRequestEvent

function isHttpRequest(request: RequestEvent): request is HttpRequestEvent {
    return 'version' in request
}

export async function awsHandler(req: RequestEvent, awsContext: AwsContext): Promise<HttpResponse> {
    const [handler] = getHandlers('http')
    if (!handler) {
        throw new Error('No http handler registered.')
    }
    const { log, context, success, flush } = createAwsContext(
        awsContext,
        { default: 15 },
        req.stageVariables,
        clientFromHeaders(req.headers ?? undefined),
        handler.config,
        handler.meta,
        awsContext.invokedFunctionArn,
    )

    if (req.body && req.isBase64Encoded) {
        req.body = Buffer.from(req.body, 'base64').toString('utf-8')
    }
    const result = await executeRequest(
        log,
        context,
        handler,
        {
            headers: requestHeaders(req),
            uri: isHttpRequest(req)
                ? `https://${req.requestContext.domainName}${escapedPath(req.rawPath)}${
                      req.rawQueryString ? '?' + req.rawQueryString : ''
                  }`
                : `https://${req.requestContext.domainName}${req.requestContext.path}`,
            ...requestBody(req.body, handler.config?.rawBody === true),
        },
        success,
    )

    const awsResult = Buffer.isBuffer(result.body)
        ? {
              statusCode: result.status,
              headers: result.headers,
              body: result.body.toString('base64'),
              isBase64Encoded: true,
          }
        : {
              statusCode: result.status,
              headers: result.headers,
              body: result.body,
          }
    await measure(log.enrichReserved({ meta: handler.meta }), 'flush', flush)
    return awsResult
}

// API Gateway decodes the path once to route it and once more into rawPath (measured on dev
// 2026-11-17: P%23A -> 'P#A', x%2523y -> 'x#y', %25252523 -> '%2523', Q%253FR -> 'Q?R', %FF -> U+FFFD;
// C%25D and %00 -> 400, and %2F, %2E%2E, '.' and Q%3FR -> 404, all before the Lambda). Escaped
// again, a step decodes to what rawPath held; a decoded '/' or '..' has moved the step boundaries.
function escapedPath(rawPath: string) {
    // eslint-disable-next-line no-control-regex
    return rawPath.replaceAll(/[\u{0}-\u{20}\u{7F}%#?\\]/gu, c => encodeURIComponent(c))
}

// A client may send x-gateway-source-ip itself, so it is always replaced or removed.
// Payload 2.0 moves the Cookie header out of headers and into cookies.
function requestHeaders(req: RequestEvent) {
    const cookies = isHttpRequest(req) ? (req.cookies ?? []) : []
    const replaced = cookies.length === 0 ? [gatewaySourceIp] : [gatewaySourceIp, 'cookie']
    const sent = Object.entries(req.headers ?? {})
    const headers = Object.fromEntries(
        sent.filter(([name]) => !replaced.includes(name.toLowerCase())),
    )
    const ip = sourceIp(req)
    if (ip) {
        headers[gatewaySourceIp] = ip
    }
    if (cookies.length !== 0) {
        headers.cookie = [
            ...sent.filter(([name]) => name.toLowerCase() === 'cookie').map(([, value]) => value),
            ...cookies,
        ].join('; ')
    }
    return headers
}

const gatewaySourceIp = 'x-gateway-source-ip'

function sourceIp(req: RequestEvent) {
    if (isHttpRequest(req)) {
        return req.requestContext.http.sourceIp
    }
    return req.requestContext.identity.sourceIp
}

// A raw-body handler verifies a signature over the bytes API Gateway received, so it is
// handed the decoded string untouched; parsing and re-serializing would not round-trip.
function requestBody(body: string | undefined, rawBody: boolean) {
    if (!body) {
        return {}
    }
    if (rawBody) {
        return { body }
    }
    return { json: JSON.parse(body) as Json }
}
