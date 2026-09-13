'use strict';

// Backend diagnostics may contain server addresses, paths or model output.
// Only these fixed codes cross the reprocess IPC boundary; diagnostics remain
// in the existing debug log. Unknown failures must never become UI copy.
function classifyReprocessError(error) {
  const message = String(error?.message || error || '').trim();
  if (/^Connection error\.$|No route to host|Connection refused|ConnectError|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|Failed to connect to Ollama|Failed to start Ollama service|Name or service not known|nodename nor servname/i.test(message)) {
    return 'generation_connection_failed';
  }
  if (/Failed to ensure model .* is available|could not find model|model\b[^\r\n]*\bnot found/i.test(message)) {
    return 'generation_model_unavailable';
  }
  if (/rejected the (request|api key)|\b(401|403)\b|unauthorized|authenticationerror/i.test(message)) {
    return 'generation_auth_failed';
  }
  if (/timed? out|timeout|watchdog/i.test(message)) return 'generation_timeout';
  if (/requires more system memory|out of memory|\bENOMEM\b/i.test(message)) {
    return 'generation_out_of_memory';
  }
  if (/is not configured/i.test(message)) return 'generation_not_configured';
  return 'generation_failed';
}

module.exports = { classifyReprocessError };
