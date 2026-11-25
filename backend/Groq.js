// ============================================================
// Groq.gs \u2014 Groq API wrapper
// ============================================================

const GROQ_ATTEMPTS = 3;

/**
 * Call the Groq chat completion endpoint and return the parsed JSON answer.
 *
 * Groq's JSON mode fails now and then on its own: it answers HTTP 400 "json_validate_failed", or the
 * model runs out of room and the JSON is cut off, or the answer is empty. None of that is the
 * user's fault, so those cases are retried (up to GROQ_ATTEMPTS tries) before anything is shown.
 * Problems retrying cannot fix (a rejected key, a bad request) fail at once with a plain message.
 */
function callGroq(messages) {
  const key = getApiKey();

  const payload = JSON.stringify({
    model: GROQ_MODEL,
    messages: messages,
    response_format: { type: 'json_object' },
    temperature: 0.4,
    // The model's own "thinking" counts against this, so too small a number cuts the JSON off.
    max_tokens: 2048
  });

  const options = {
    method: 'post',
    headers: {
      'Authorization': 'Bearer ' + key,
      'Content-Type':  'application/json'
    },
    payload: payload,
    muteHttpExceptions: true
  };

  let why = '';
  for (let attempt = 1; attempt <= GROQ_ATTEMPTS; attempt++) {
    const resp = UrlFetchApp.fetch('https://api.groq.com/openai/v1/chat/completions', options);
    const code = resp.getResponseCode();
    const text = resp.getContentText();

    if (code === 429) {                       // rate limited: wait a moment and try again
      why = 'Groq is rate limiting this key right now. Wait a minute and try again.';
      if (attempt < GROQ_ATTEMPTS) Utilities.sleep(3000);
      continue;
    }
    if (code === 401 || code === 403) {
      throw _err('bad_key', 'Groq did not accept your API key. In the sheet, open LearnerBot \u2192 Set Groq API key and paste it again.');
    }
    if (code >= 500) {                        // Groq hiccup
      why = 'Groq had a temporary problem (' + code + '). Try again in a moment.';
      if (attempt < GROQ_ATTEMPTS) Utilities.sleep(1500);
      continue;
    }
    if (code === 400 && /json_validate_failed/.test(text)) {   // the model produced JSON Groq could not accept
      why = 'The AI answered in a format the app could not read.';
      Logger.log('Attempt ' + attempt + ': json_validate_failed');
      continue;
    }
    if (code !== 200) {
      throw new Error('Groq API returned ' + code + ': ' + text.slice(0, 300));
    }

    let content = '';
    try {
      const choice = JSON.parse(text).choices[0];
      content = (choice.message && choice.message.content) || '';
      if (choice.finish_reason === 'length') Logger.log('Attempt ' + attempt + ': answer was cut off (max_tokens)');
    } catch (_) { /* treated as an unreadable answer below */ }

    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      throw new Error('not an object');
    } catch (parseErr) {
      why = 'The AI answered in a format the app could not read.';
      Logger.log('Attempt ' + attempt + ' parse failed: ' + String(content).slice(0, 200));
    }
  }

  throw _err('ai_failed', why + ' It was tried ' + GROQ_ATTEMPTS + ' times; nothing was changed. Please try again.');
}

