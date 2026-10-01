import { claim } from '@movogo-io/host/attribution'
import type { ClientInfo, RootLogger } from '@movogo-io/host/context'
import { handle } from '@movogo-io/host/event'
import type { EventHandler } from '@movogo-io/host/event-registry'
import { measure, type Json } from '@movogo-io/host/lib/event'
import { getHandlers } from '@movogo-io/host/registry'
import { brotliDecompress } from 'node:zlib'
import { AwsContext, createAwsContext, missing, type Attribution } from './context.js'

export { setMeta } from '@movogo-io/host/registry'
export * from '@movogo-io/service/event'

// https://github.com/DefinitelyTyped/DefinitelyTyped/blob/b969f890000ff95740fd7b879cdf3b73e1ea0fe8/types/aws-lambda/trigger/sns.d.ts

type SNSMessageAttribute = {
    Type: string
    Value: string
}

type SNSMessageAttributes = {
    [name: string]: SNSMessageAttribute
}

type SNSMessage = {
    SignatureVersion: string
    Timestamp: string
    Signature: string
    SigningCertUrl: string
    MessageId: string
    Message: string
    MessageAttributes: SNSMessageAttributes
    Type: string
    UnsubscribeUrl: string
    TopicArn: string
    Subject?: string
    Token?: string
}

type SNSEventRecord = {
    EventVersion: string
    EventSubscriptionArn: string
    EventSource: string
    Sns: SNSMessage
}

type SNSEvent = {
    Records: SNSEventRecord[]
}

export async function awsHandler(event: SNSEvent, awsContext: AwsContext) {
    const [handler] = getHandlers('event')
    if (!handler) {
        throw new Error('No event handler registered.')
    }
    const handled = await Promise.allSettled(
        event.Records.map(r => handleRecord(r, handler, awsContext)),
    )
    const failed = handled.filter(e => e.status === 'rejected')
    if (failed.length !== 0 || handled.some(e => e.status === 'fulfilled' && !e.value)) {
        throw new AggregateError(
            failed.map(e => e.reason as unknown),
            'Error handling event.',
        )
    }
}

// Each record gets its own context: the client and the attribution restored from its
// attributes are the record's, not the batch's.
async function handleRecord(record: SNSEventRecord, handler: EventHandler, awsContext: AwsContext) {
    const { log, context, success, flush } = createAwsContext(
        awsContext,
        { default: 150 },
        {},
        clientFromAttributes(record.Sns.MessageAttributes),
        handler.config,
        handler.meta,
        awsContext.invokedFunctionArn,
        attributionFromAttributes(record.Sns.MessageAttributes),
    )
    try {
        const options = await parseRecord(record, log)
        try {
            return await handle(log, context, handler, options, success)
        } catch (e) {
            log.fatal('Error sending event.', e)
            throw e
        }
    } finally {
        await measure(log.enrichReserved({ meta: handler.meta }), 'flush', flush)
    }
}

async function parseRecord(record: SNSEventRecord, log: RootLogger) {
    try {
        return {
            subject: record.Sns.Subject ?? missing('subject'),
            timestamp: new Date(record.Sns.Timestamp),
            messageId: record.Sns.MessageId,
            event: await eventFromMessage(record.Sns.Message, record.Sns.MessageAttributes),
        }
    } catch (e) {
        log.fatal('Error parsing event.', e)
        throw e
    }
}

function clientFromAttributes(attributes: SNSMessageAttributes | undefined): ClientInfo {
    if (!attributes) {
        return {}
    }
    return {
        clientId: attributes.clientId?.Value,
        clientIp: attributes.clientIp?.Value,
        clientPort: Number(attributes.clientPort?.Value) || undefined,
        operationId: attributes.operationId?.Value,
        userAgent: attributes.userAgent?.Value,
    }
}

function attributionFromAttributes(attributes: SNSMessageAttributes | undefined): Attribution {
    if (!attributes?.onBehalfOfUserId?.Value) {
        return {}
    }
    return {
        onBehalfOf: claim(attributes.onBehalfOfUserId.Value, attributes.onBehalfOfOrg?.Value),
    }
}

async function eventFromMessage(message: string, attributes?: SNSMessageAttributes) {
    if (!message) {
        return undefined
    }

    const messageToParse = await getMessageToParse(message, attributes)
    return JSON.parse(messageToParse) as {
        readonly [key: string]: Json
    }
}

async function getMessageToParse(message: string, attributes?: SNSMessageAttributes) {
    const isCompressed = attributes?.['content-encoding']?.Value === 'br'
    if (!isCompressed) {
        return message
    }
    const decompressed = await decompress(Buffer.from(message, 'base64'))
    return decompressed.toString('utf-8')
}

function decompress(data: Buffer) {
    return new Promise<Buffer>((resolve, reject) => {
        brotliDecompress(data, (err, result) => {
            if (err) {
                reject(err)
                return
            }
            resolve(result)
        })
    })
}
