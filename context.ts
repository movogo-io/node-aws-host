import {
    ClientInfo,
    createContext,
    LogEntry,
    LogTransport,
    type EventTransport,
} from '@movogo-io/host/context'
import { FullConfiguration, Metadata } from '@movogo-io/host/registry'
import type { Attribution, Environment } from '@movogo-io/service/context'
import { randomUUID } from 'node:crypto'
import { SnsEventTransport } from './lib/sns.js'

export { setMeta } from '@movogo-io/host/registry'
export * from '@movogo-io/service/context'

export type AwsContext = {
    getRemainingTimeInMillis(): number
    readonly functionName: string
    readonly functionVersion: string
    readonly invokedFunctionArn: string
    readonly memoryLimitInMB: number
    readonly awsRequestId: string
    readonly logGroupName: string
    readonly logStreamName: string
    callbackWaitsForEmptyEventLoop: boolean
}

/* eslint-disable no-console */
class ConsoleLogger implements LogTransport {
    sendEntries(entries: LogEntry[]) {
        for (const entry of entries) {
            consoleLogEntry(entry)
        }
        return undefined
    }
}

function consoleLogEntry(entry: LogEntry) {
    switch (entry.level) {
        case 'trace':
        case 'debug':
            console.debug(entry.json)
            break
        case 'info':
            console.log(entry.json)
            break
        case 'warning':
            console.warn(entry.json)
            break
        case 'error':
        case 'fatal':
            console.error(entry.json)
            break
    }
}

const consoleLogger = new ConsoleLogger()

const hostInfo = {
    instance: {
        id: randomUUID().replaceAll('-', ''),
    },
    nodejs: {
        version: process.version.slice(1),
    },
    environment: process.env.AWS_EXECUTION_ENV,
}

export function createAwsContext(
    context: AwsContext,
    timeouts: {
        default: number
        cap?: number
    },
    stageVariables: { [key: string]: string },
    client: ClientInfo,
    config: FullConfiguration | undefined,
    meta: Metadata | undefined,
    functionArn: string,
    attribution?: Attribution,
) {
    const env = {
        ...process.env,
        ...stageVariables,
    }
    // The transport exists before the context's logger does; it warns through this sink,
    // which is pointed at the created logger below.
    const sink: WarnSink = {}
    const ctx = createContext(
        client,
        [consoleLogger],
        getEventTransport(client, env, meta, functionArn, sink),
        timeouts,
        new AbortController(),
        config,
        meta,
        env,
        undefined,
        attribution,
    )
    ctx.log = ctx.log.enrichReserved({
        host: hostInfo,
        function: {
            name: context.functionName,
            memory: context.memoryLimitInMB,
            timeout: context.getRemainingTimeInMillis(),
        },
    })
    sink.warn = (message, fields) => {
        ctx.log.warn(message, undefined, fields)
    }
    return ctx
}

export type WarnSink = {
    warn?: (message: string, fields: { topic: string; type: string }) => void
}

function getEventTransport(
    client: ClientInfo,
    env: Partial<Environment>,
    meta: Metadata | undefined,
    functionArn: string,
    sink: WarnSink,
) {
    try {
        return new SnsEventTransport(client, env, meta, functionArn, sink)
    } catch (e) {
        return new ErrorEventTransport(e)
    }
}

class ErrorEventTransport implements EventTransport {
    readonly #error: unknown

    constructor(error: unknown) {
        this.#error = error
    }

    sendEvent() {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        return Promise.reject(this.#error)
    }
}
