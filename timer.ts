import { measure } from '@movogo-io/host/lib/timer'
import { getHandlers } from '@movogo-io/host/registry'
import { triggerTimer } from '@movogo-io/host/timer'
import { AwsContext, createAwsContext } from './context.js'

export { setMeta } from '@movogo-io/host/registry'
export * from '@movogo-io/service/timer'

// https://github.com/DefinitelyTyped/DefinitelyTyped/blob/b969f890000ff95740fd7b879cdf3b73e1ea0fe8/types/aws-lambda/trigger/eventbridge.d.ts

type EventBridgeEvent = {
    version: '0'
    id: string
    account: string
    time: string
    region: string
    resources: string[]
    source: string
}

export async function awsHandler(event: EventBridgeEvent, awsContext: AwsContext) {
    const [handler] = getHandlers('timer')
    if (!handler) {
        throw new Error('No timer handler registered.')
    }
    const { log, context, success, flush } = createAwsContext(
        awsContext,
        { default: 300 },
        {},
        {
            operationId: event.id,
        },
        handler.config,
        handler.meta,
        awsContext.invokedFunctionArn,
    )

    await triggerTimer(
        log,
        context,
        handler,
        {
            triggerTime: new Date(event.time),
        },
        success,
    )

    await measure(log.enrichReserved({ meta: handler.meta }), 'flush', flush)
}
