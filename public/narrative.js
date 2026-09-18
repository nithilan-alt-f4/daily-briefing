/**
 * narrative.js — On-device briefing narrative generation via Groq API.
 * Ported from server-side src/services/summarizer.js generateBriefingNarrative().
 * Also handles smart note parsing (text + image) via Gemini API.
 *
 * Exposes window.NarrativeAPI globally.
 */
(function () {
  'use strict';

  var GROQ_API = 'https://api.groq.com/openai/v1/chat/completions';
  var GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';
  var MODEL = 'openai/gpt-oss-20b';

  // --- Groq chat helper ---

  function groqChat(prompt, maxTokens, apiKey) {
    maxTokens = maxTokens || 1500;
    return fetch(GROQ_API, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: prompt }],
        model: MODEL,
        max_tokens: maxTokens,
        temperature: 0.3
      })
    })
      .then(function (res) {
        if (!res.ok) throw new Error('Groq API ' + res.status);
        return res.json();
      })
      .then(function (data) {
        var content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
        // Strip <think>...</think> tags
        content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        return content;
      });
  }

  // --- Gemini helpers ---

  function geminiGenerate(prompt, apiKey, parts) {
    parts = parts || [{ text: prompt }];
    return fetch(GEMINI_API + '?key=' + apiKey, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: parts }]
      })
    })
      .then(function (res) {
        if (!res.ok) throw new Error('Gemini API ' + res.status);
        return res.json();
      })
      .then(function (data) {
        var text = '';
        try { text = data.candidates[0].content.parts[0].text; } catch (e) { /* ignore */ }
        return text;
      });
  }

  // --- Narrative generation ---

  /**
   * Generate the daily briefing narrative.
   * @param {Object} briefingData - { weather, classes, classesLabel, todaySchoolNotifications, recentEmails, news, eventsThisWeek }
   * @returns {Promise<string|null>} narrative text or null
   */
  function generateNarrative(briefingData) {
    return SecureStore.getGroqKey().then(function (apiKey) {
      if (!apiKey) return null;

      var prompt =
        'You are writing a daily briefing addressed directly to a school student (the user). ' +
        'Write a short natural paragraph (4-5 sentences) telling them what matters today. Rules:\n' +
        '- Use "you" and "your". Never mention parents\n' +
        '- If classes are provided, mention them naturally. Use the classesLabel to know when to say "today" vs "tomorrow":\n' +
        '  - If classesLabel is "Remaining today", say something like "You still have X, Y, and Z left today."\n' +
        '  - If classesLabel is "Tomorrow", say something like "Tomorrow you have X, Y, and Z."\n' +
        '  - If classesLabel is empty or no classes, skip this part entirely\n' +
        '- IMPORTANT: if a school notification contains instructions (what to wear, what to bring, timings, deadlines), state them explicitly, e.g. "Wear your sports uniform on Friday"\n' +
        '- Mention the weather and whether they need an umbrella\n' +
        '- Use **double asterisks** around the 1-3 most important words or instructions (they render bold)\n' +
        '- When mentioning a specific news story or email, wrap its exact title in [[News: title]] or [[Mail: title]] so it becomes a link\n' +
        '- NEVER use em dashes (the - character). Use commas, periods or colons instead\n' +
        '- Keep it under 100 words\n' +
        'Data:\n' + JSON.stringify(briefingData, null, 2).substring(0, 5000);

      return groqChat(prompt, 500, apiKey);
    }).catch(function (err) {
      console.error('[Narrative] Generation failed:', err.message);
      return null;
    });
  }

  // --- Smart Note parsing (text → calendar event or note) ---

  /**
   * Parse freeform text into a calendar event or plain note using Gemini.
   * @param {string} text - user input
   * @returns {Promise<Object>} parsed { isEvent, isSchool, title, date, startTime, endTime, location, description }
   */
  function parseSmartNote(text) {
    return SecureStore.getGeminiKey().then(function (apiKey) {
      if (!apiKey) throw new Error('Gemini API key not configured');

      var istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
      var istDate = istNow.toISOString().slice(0, 10);
      var dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      var istDay = dayNames[istNow.getUTCDay()];
      var tomorrow = new Date(istNow.getTime() + 86400000).toISOString().slice(0, 10);

      var prompt =
        'You are a smart calendar assistant. Parse this note from a school student.\n\n' +
        'Today is ' + istDay + ', ' + istDate + ' (IST timezone, Asia/Kolkata).\n\n' +
        'Note: "' + text.replace(/"/g, '\\"') + '"\n\n' +
        'Determine if this is a calendar-worthy event. If it IS, return JSON:\n' +
        '{ "isEvent": true, "isSchool": true/false, "title": "clean title", "date": "YYYY-MM-DD", "startTime": "HH:MM" or null, "endTime": "HH:MM" or null, "location": "inferred or null", "description": "short note" }\n\n' +
        'If NOT calendar-worthy, return JSON:\n' +
        '{ "isEvent": false, "isSchool": false, "title": "the note as-is", "date": null, "startTime": null, "endTime": null, "location": null, "description": null }\n\n' +
        'For "isSchool": true if school-related (classes, exams, tests, practicals, coaching, etc.). False for personal (birthdays, shopping, outings, etc.).\n\n' +
        'Rules:\n' +
        '- "sunday" means the upcoming Sunday\n' +
        '- "tomorrow" = ' + tomorrow + '\n' +
        '- "moa" → location = "Mall of Asia"\n' +
        '- If no time given, leave startTime null\n' +
        '- If mentions a deadline ("submit by", "due"), set startTime to null\n' +
        '- Return ONLY the JSON object';

      return geminiGenerate(prompt, apiKey).then(function (raw) {
        var jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON in Gemini response');
        return JSON.parse(jsonMatch[0]);
      });
    });
  }

  // --- Smart Note Photo parsing (image → calendar events) ---

  /**
   * Parse an image (handwritten note or timetable) into calendar events using Gemini.
   * @param {string} imageBase64 - base64-encoded image data (no data: prefix)
   * @param {string} mimeType - e.g. 'image/jpeg'
   * @returns {Promise<Object>} { type: 'single'|'timetable'|'none', events: [...] }
   */
  function parseSmartNotePhoto(imageBase64, mimeType) {
    return SecureStore.getGeminiKey().then(function (apiKey) {
      if (!apiKey) throw new Error('Gemini API key not configured');

      var istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
      var istDate = istNow.toISOString().slice(0, 10);
      var CURRENT_YEAR = istNow.getFullYear();
      var dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      var istDay = dayNames[istNow.getUTCDay()];
      var tomorrow = new Date(istNow.getTime() + 86400000).toISOString().slice(0, 10);

      var prompt =
        'You are a smart calendar assistant. Analyze this image from a school student.\n\n' +
        'Today is ' + istDay + ', ' + istDate + ' (IST timezone, Asia/Kolkata).\n\n' +
        'Determine what this image contains:\n\n' +
        '1. If it\'s a SINGLE note, return: { "type": "single", "events": [{ "title": "...", "date": "YYYY-MM-DD", "startTime": "HH:MM" or null, "endTime": "HH:MM" or null, "location": "inferred or null", "description": "...", "weekly": false, "dayOfWeek": null, "isSchool": true/false }] }\n' +
        '2. If it\'s a TIMETABLE with MULTIPLE classes, return: { "type": "timetable", "events": [ ... ] }\n' +
        '3. If NOT calendar-worthy, return: { "type": "none", "events": [] }\n\n' +
        'For each event: year is ' + CURRENT_YEAR + '. "sunday"/"monday" etc. = UPCOMING occurrence. "tomorrow" = ' + tomorrow + '. ' +
        'Recurring weekly → weekly=true, dayOfWeek="Monday" etc. Common abbreviations: phy→Physics, chem→Chemistry, math→Mathematics, bio→Biology.\n' +
        'Return ONLY the JSON object';

      var parts = [
        { text: prompt },
        { inline_data: { mime_type: mimeType || 'image/jpeg', data: imageBase64 } }
      ];

      return geminiGenerate(null, apiKey, parts).then(function (raw) {
        var jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON in Gemini response');
        var parsed = JSON.parse(jsonMatch[0]);
        // Normalize events
        parsed.events = (parsed.events || []).map(function (e) {
          return Object.assign({}, e, {
            date: e.date || e.singleDate || null,
            isSchool: e.isSchool || false
          });
        });
        return parsed;
      });
    });
  }

  // --- Extract events from timetable image ---

  /**
   * Extract events from a timetable image.
   * @param {string} imageBase64 - base64-encoded image
   * @param {string} mimeType - e.g. 'image/jpeg'
   * @returns {Promise<Array>} array of event objects
   */
  function extractTimetable(imageBase64, mimeType) {
    return SecureStore.getGeminiKey().then(function (apiKey) {
      if (!apiKey) throw new Error('Gemini API key not configured');

      var CURRENT_YEAR = new Date().getFullYear();

      var prompt =
        'Extract all classes, exams, and events from this timetable image. Return ONLY a JSON array. ' +
        'Each item: { "title": "Class name", "singleDate": "YYYY-MM-DD" or null, "dayOfWeek": "Monday"/"Tuesday"/etc or null, ' +
        '"weekly": true/false, "startTime": "HH:MM" or null, "endTime": "HH:MM" or null }. ' +
        'Use year ' + CURRENT_YEAR + '. No extra text, just JSON.';

      var parts = [
        { text: prompt },
        { inline_data: { mime_type: mimeType || 'image/jpeg', data: imageBase64 } }
      ];

      return geminiGenerate(null, apiKey, parts).then(function (raw) {
        var jsonMatch = raw.match(/\[[\s\S]*\]/);
        if (!jsonMatch) throw new Error('No JSON array in Gemini response');
        return JSON.parse(jsonMatch[0]);
      });
    });
  }

  // --- Expose globally ---

  window.NarrativeAPI = {
    generateNarrative: generateNarrative,
    parseSmartNote: parseSmartNote,
    parseSmartNotePhoto: parseSmartNotePhoto,
    extractTimetable: extractTimetable
  };
})();
