# Project Overview

This is `@movogo-io/aws-host`, a TypeScript AWS Lambda host adapter for the Riddance serverless framework. It provides AWS-specific implementations for HTTP, event, timer, and context handling in Lambda functions by providing Lambda entry points that translate Lambda-specific idioms to Riddance idioms.

Though we depend on `@movogo-io/service` we do so to implement it, not to use it.

## Core Components

**Main Entry Points**:

- `context.ts` - Creates a Riddance context that establishes metadata, logging and event transport for Riddance functions based on what the Lambda runtime provides.
- `http.ts` - Handles events from AWS API Gateway, sends them to Riddance HTTP handler, and maps the response back to the gateway.
- `timer.ts` - Takes an EventBridge timer/scheduled event and forwards it to Riddance timer handler.
- `event.ts` - Takes an SNS event and forwards it to Riddance event handler.

**Supporting Infrastructure**:

- `lib/sns.ts` - Event transport that sends events emitted from Riddance handlers to SNS. Events sent this way are in turn handled by `events.ts`
