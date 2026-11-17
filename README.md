# Project Overview

This is `@movogo-io/aws-host`, a TypeScript AWS Lambda host adapter for the Riddance serverless framework. It provides AWS-specific implementations for HTTP, event, timer, and context handling in Lambda functions by providing Lambda entry points that translate Lambda-specific idioms to Riddance idioms.

Though we depend on `@movogo-io/service` we do so to implement it, not to use it.

## Core Components

**Main Entry Points**:

- `context.ts` - Creates a Riddance context that establishes metadata, logging and event transport for Riddance functions based on what the Lambda runtime provides.
- `http.ts` - Handles events from AWS API Gateway, sends them to Riddance HTTP handler, and maps the response back to the gateway. A handler configured with `rawBody: true` is handed the request body as the string API Gateway received (base64-decoded when the gateway encoded it), never parsed, so a webhook's signature can be verified over those bytes; the Riddance host hands a test's `json` to such a handler serialized, so tests take the same path.
  API Gateway hands over the path percent-decoded, so the adapter escapes it again: a step decodes (`decodeURIComponent(request.url.pathStepAt(i))`) to what API Gateway decoded, `#` and `?` included. A `/` or a `..` the client escaped has already moved the step boundaries, so an id that can hold one does not belong in the path.
  A payload 2.0 event's `cookies` reach the handler joined into one lower-case `cookie` header, after any cookie header the event also carried; a REST (payload 1.0) event's headers keep the case the client sent. The address API Gateway saw (`sourceIp`) reaches the handler as the `x-gateway-source-ip` request header, replacing any value the client sent in any case and removed when API Gateway gave none; it is the client's address only while API Gateway is the edge (behind CloudFront it is CloudFront's). `context.client.ip` still follows `X-Forwarded-For`, which the client controls.
  A response sets at most one cookie: a handler's headers hold one string per name, browsers do not split a comma-joined `Set-Cookie`, and the adapter does not map to payload 2.0's response `cookies` list.
- `timer.ts` - Takes an EventBridge timer/scheduled event and forwards it to Riddance timer handler.
- `event.ts` - Takes an SNS event and forwards it to Riddance event handler.

**Supporting Infrastructure**:

- `lib/sns.ts` - Event transport that sends events emitted from Riddance handlers to SNS. Events sent this way are in turn handled by `events.ts`
