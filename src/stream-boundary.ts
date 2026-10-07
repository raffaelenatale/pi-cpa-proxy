import { isContextOverflow, createAssistantMessageEventStream, type AssistantMessageEventStream, type ProviderStreams, type Model, type Api, type AssistantMessage } from '@earendil-works/pi-ai';

import { protectedFetch } from './transport-fetch.ts';
import { logStreamEvent } from './logger.ts';

/** Keep native wire implementation; only normalize failed stream diagnostics at our boundary. */
export function guardedStreams(native: ProviderStreams): ProviderStreams {
  function bridge(model: Model<Api>, start: () => AssistantMessageEventStream): AssistantMessageEventStream {
    const output = createAssistantMessageEventStream();
    logStreamEvent('INFO', 'STREAM_START', { model: model.id, provider: model.provider, api: model.api });
    const clean = (message: AssistantMessage) => {
      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        const rawError = message.errorMessage;
        const rawDiagnostics = message.diagnostics;
        // Keep context-overflow classification useful without preserving provider text in Pi history.
        const overflow = isContextOverflow(message, model.contextWindow);
        message.errorMessage = message.stopReason === 'aborted' ? 'cpa_request_aborted' : overflow ? 'cpa_context_length_exceeded' : 'cpa_stream_failed';
        logStreamEvent('ERROR', 'STREAM_FAILED', {
          model: model.id,
          provider: model.provider,
          api: model.api,
          stopReason: message.stopReason,
          rawErrorMessage: rawError,
          normalizedErrorMessage: message.errorMessage,
          diagnostics: rawDiagnostics,
        });
        delete message.diagnostics;
      }
    };
    void (async () => {
      try {
        const source = start();
        for await (const event of source) {
          if ('partial' in event) clean(event.partial);
          if (event.type === 'error') clean(event.error);
          if (event.type === 'done') clean(event.message);
          output.push(event);
        }
        const result = await source.result();
        clean(result);
        if (result.stopReason !== 'error' && result.stopReason !== 'aborted') {
          logStreamEvent('INFO', 'STREAM_COMPLETED', {
            model: model.id,
            provider: model.provider,
            stopReason: result.stopReason,
            usage: result.usage,
          });
        }
        output.end(result);
      } catch (thrown) {
        logStreamEvent('ERROR', 'STREAM_THROWN', {
          model: model.id,
          provider: model.provider,
          api: model.api,
          error: thrown instanceof Error ? { message: thrown.message, stack: thrown.stack } : String(thrown),
        });
        const message: AssistantMessage = {
          role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [], timestamp: Date.now(),
          stopReason: 'error', errorMessage: 'cpa_stream_failed',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        output.push({ type: 'error', reason: 'error', error: message }); output.end(message);
      }
    })();
    return output;
  }
  return {
    stream: (model, context, options) => bridge(model, () => native.stream(model, context,
      model.api === 'google-generative-ai' ? options : { ...options, fetch: protectedFetch(options?.fetch) })),
    streamSimple: (model, context, options) => bridge(model, () => native.streamSimple(model, context,
      model.api === 'google-generative-ai' ? options : { ...options, fetch: protectedFetch(options?.fetch) })),
  };
}
