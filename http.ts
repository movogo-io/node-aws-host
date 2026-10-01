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
            sourceIp: string
            userAgent: string
        }
    }
    headers: { [key: string]: string }
    multiValueHeaders: { [key: string]: string[] }
    multiValueQueryStringParameters: { [key: string]: string[] }
} & CommonRequestEvent

type HttpRequestEvent = {
    version: '2.0'
    routeKey: string
    rawPath: string
    rawQueryString: string
    headers: { [key: string]: string }
    cookies: { [key: string]: string }
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
            sourceIp: string
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

function isHttpRequest(request: RequestEvent) {
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
        clientFromHeaders(req.headers),
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
            headers: req.headers,
            uri: isHttpRequest(req)
                ? `https://${req.requestContext.domainName}${req.rawPath}${
                      req.rawQueryString ? '?' + req.rawQueryString : ''
                  }`
                : `https://${req.requestContext.domainName}${req.requestContext.path}`,
            json: req.body ? (JSON.parse(req.body) as Json) : undefined,
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
