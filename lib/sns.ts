import { fetchOK, thrownHasStatus } from '@riddance/fetch'
import { type ClientInfo, type EventTransport } from '@movogo-io/host/context'
import type { Metadata } from '@movogo-io/host/registry'
import { missing } from '@movogo-io/service/context'
import { SignatureV4 } from '@smithy/signature-v4'
import { createHash, createHmac, randomUUID, type Hash } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { brotliCompress } from 'node:zlib'
import {
    type Attribution,
    type Environment,
    type EventAttributes,
    type Json,
    type WarnSink,
} from '../context.js'

const publishAttemptsMax = 5

/**
Test seams only: a mock server to publish to instead of the region's SNS endpoint, and a
shorter backoff. Production passes neither; the environment is never consulted for them.
*/
export type SnsTransportOptions = {
    readonly baseUrl?: string
    readonly retryDelayBaseMs?: number
}

export class SnsEventTransport implements EventTransport {
    readonly #attributes: { [key: string]: string }
    readonly #env: Partial<Environment>
    readonly #baseUrl: string
    readonly #baseArn: string
    readonly #warn: WarnSink
    readonly #retryDelayBaseMs: number

    constructor(
        client: ClientInfo,
        env: Partial<Environment>,
        meta: Metadata | undefined,
        functionArn: string,
        warn: WarnSink,
        options?: SnsTransportOptions,
    ) {
        // The request id a client sent is for the logs of this invocation, not for the bus:
        // the operation id joins the two already, and an unknown attribute on the wire is one
        // more name an emitter cannot use.
        const { clientRequestId: _clientRequestId, ...wire } = client
        this.#attributes = asMessageAttributes(wire)
        this.#env = env
        this.#warn = warn
        this.#retryDelayBaseMs = options?.retryDelayBaseMs ?? 100
        const region = env.AWS_REGION ?? missing('AWS_REGION')
        this.#baseUrl = options?.baseUrl ?? `https://sns.${region}.amazonaws.com`
        const prefix =
            env.AWS_LAMBDA_FUNCTION_NAME?.slice(
                0,
                -(meta?.packageName.length ?? missing('meta.packageName')) -
                    (meta?.fileName.length ?? missing('meta.fileName')) -
                    2,
            ) ?? missing('AWS_LAMBDA_FUNCTION_NAME')
        this.#baseArn = `arn:aws:sns:${region}:${functionArn.split(':', 5)[4] ?? missing('valid ARN')}:${prefix}-`
    }

    async sendEvent(
        topic: string,
        type: string,
        subject: string,
        data:
            | {
                  readonly [key: string]: Json
              }
            | undefined,
        messageId: string | undefined,
        signal: AbortSignal,
        extras?: { attributes?: EventAttributes; attribution?: Attribution },
    ) {
        // Wire order: client, then the attribution claim, then the emitter's attributes,
        // then content-encoding, each numbered after all of the previous.
        const onBehalfOf = asMessageAttributes(
            {
                onBehalfOfUserId: extras?.attribution?.onBehalfOf?.userId,
                onBehalfOfOrg: extras?.attribution?.onBehalfOf?.org,
            },
            this.#attributes,
        )
        const emitter = asMessageAttributes(extras?.attributes ?? {}, {
            ...this.#attributes,
            ...onBehalfOf,
        })
        const { message, additionalAttributes } = await prepareMessage(data, {
            ...this.#attributes,
            ...onBehalfOf,
            ...emitter,
        })
        const body = new URLSearchParams({
            Version: '2010-03-31',
            Action: 'Publish',
            TopicArn: `${this.#baseArn}${topic}-${type}`,
            Message: message ?? 'null',
            Subject: subject,
            MessageId: messageId ?? randomUUID().replaceAll('-', ''),
            Type: type,
            ...this.#attributes,
            ...onBehalfOf,
            ...emitter,
            ...additionalAttributes,
        }).toString()

        for (let attempt = 0; ; ++attempt) {
            try {
                await awsFetchOK(
                    this.#env,
                    this.#baseUrl,
                    {
                        headers: {
                            'content-type': 'application/x-www-form-urlencoded',
                            'x-amz-date': new Date().toISOString(),
                        },
                        method: 'POST',
                        body,
                        signal,
                    },
                    'Error publishing SNS message.',
                    { topic, type, data },
                )
                return
            } catch (e) {
                if (thrownHasStatus(e, 404)) {
                    this.#warn.warn?.('Topic not found; event dropped.', { topic, type })
                    return
                }
                if (attempt + 1 < publishAttemptsMax && isRetryable(e)) {
                    signal.throwIfAborted()
                    await setTimeout(
                        this.#retryDelayBaseMs * 2 ** attempt +
                            Math.random() * this.#retryDelayBaseMs,
                        undefined,
                        { signal },
                    )
                    continue
                }
                throw e
            }
        }
    }
}

function isRetryable(e: unknown) {
    const status = (e as { response?: { status?: unknown } } | undefined)?.response?.status
    return status === 429 || (typeof status === 'number' && status >= 500 && status <= 599)
}

async function prepareMessage(
    data:
        | {
              readonly [key: string]: Json
          }
        | undefined,
    baseAttributes: { [key: string]: string },
) {
    if (!data) {
        return {}
    }
    const jsonMessage = JSON.stringify(data)
    if (jsonMessage.length < 8192) {
        return { message: jsonMessage }
    }

    return {
        message: await compressMessage(jsonMessage),
        additionalAttributes: asMessageAttributes({ 'content-encoding': 'br' }, baseAttributes),
    }
}

async function compressMessage(jsonMessage: string) {
    const compressed = await brotliCompressAsync(jsonMessage)
    return compressed.toString('base64')
}

function brotliCompressAsync(data: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        brotliCompress(Buffer.from(data, 'utf-8'), (err, result) => {
            if (err) {
                reject(err)
                return
            }
            resolve(result)
        })
    })
}

function asMessageAttributes(
    obj: { [key: string]: string | number | undefined },
    existingAttributes?: { [key: string]: unknown },
) {
    const baseIndex = existingAttributes ? Object.keys(existingAttributes).length / 3 + 1 : 1
    return Object.fromEntries(
        Object.entries(obj)
            .filter(withoutUndefinedValue)
            .flatMap(([k, v], ix) => [
                [`MessageAttributes.entry.${baseIndex + ix}.Name`, k],
                [
                    `MessageAttributes.entry.${baseIndex + ix}.Value.DataType`,
                    typeof v === 'number' ? 'Number' : 'String',
                ],
                [`MessageAttributes.entry.${baseIndex + ix}.Value.StringValue`, v.toString()],
            ]),
    )
}

function withoutUndefinedValue(
    kvp: [string, string | number | undefined],
): kvp is [string, string | number] {
    return kvp[1] !== undefined
}

type RequestInit = {
    method: string
    headers?: { [key: string]: string }
    body?: string
    signal: AbortSignal
}

async function awsFetchOK(
    env: { [key: string]: string | undefined },
    url: string,
    init: RequestInit | undefined,
    errorMessage: string,
    errorData?: {
        [key: string]: unknown
    },
) {
    return fetchOK(
        url,
        {
            ...init,
            headers: await awsHeaders(
                env,
                'sns',
                url,
                init?.method ?? 'GET',
                init?.headers ?? {},
                init?.body ?? '',
            ),
        },
        errorMessage,
        errorData,
    )
}

async function awsHeaders(
    env: { [key: string]: string | undefined },
    service: string,
    url: string,
    method: string,
    headers: { [key: string]: string },
    body: string,
) {
    const signer = new SignatureV4({
        service,
        region: env.AWS_REGION ?? 'us-east-1',
        sha256: AwsHash,
        credentials: {
            accessKeyId: env.AWS_ACCESS_KEY_ID ?? missing('AWS_ACCESS_KEY_ID'),
            secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? missing('AWS_SECRET_ACCESS_KEY'),
            sessionToken: env.AWS_SESSION_TOKEN,
        },
    })
    const uri = new URL(url)
    const query: { [key: string]: string } = {}
    uri.searchParams.forEach((value, key) => {
        query[key] = value
    })
    const signed = await signer.sign({
        method,
        protocol: 'https:',
        hostname: uri.hostname,
        path: uri.pathname,
        query,
        headers: {
            host: uri.hostname,
            ...headers,
        },
        body,
    })
    return signed.headers
}

type SourceData = string | ArrayBuffer | ArrayBufferView

class AwsHash {
    readonly #secret?: SourceData
    #hash: Hash | ReturnType<typeof createHmac>

    constructor(secret?: SourceData) {
        this.#secret = secret
        this.#hash = makeHash(this.#secret)
    }

    digest() {
        return Promise.resolve(this.#hash.digest())
    }

    reset() {
        this.#hash = makeHash(this.#secret)
    }

    update(chunk: Uint8Array) {
        this.#hash.update(new Uint8Array(Buffer.from(chunk)))
    }
}

function makeHash(secret?: SourceData) {
    return secret ? createHmac('sha256', castSourceData(secret)) : createHash('sha256')
}

function castSourceData(data: SourceData) {
    if (Buffer.isBuffer(data)) {
        return data
    }
    if (typeof data === 'string') {
        return Buffer.from(data)
    }
    if (ArrayBuffer.isView(data)) {
        return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    }
    return Buffer.from(data)
}
