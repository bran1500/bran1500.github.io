// ── Constants ──────────────────────────────────────────────────────────────

const WK_BASE = 'https://api.wanikani.com/v2';
const WK_REVISION = '20170710';
const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-sonnet-4-6';

const CACHE_SUBJECTS_KEY = 'kp_subjects';
const CACHE_SUBJECTS_TS_KEY = 'kp_subjects_ts';
const CACHE_STORY_KEY = 'kp_story';
const CACHE_STORY_TS_KEY = 'kp_story_ts';
const CACHE_FINGERPRINT_KEY = 'kp_fingerprint';
const SUBJECTS_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FINGERPRINT_THRESHOLD = 20; // regenerate if word count changes by this much

// ── Storage helpers ────────────────────────────────────────────────────────

function loadSettings() {
  return {
    wkToken: localStorage.getItem('kp_wk_token') || '',
    claudeKey: localStorage.getItem('kp_claude_key') || '',
  };
}

function saveSettings(wkToken, claudeKey) {
  localStorage.setItem('kp_wk_token', wkToken);
  localStorage.setItem('kp_claude_key', claudeKey);
}

function loadCachedStory() {
  try {
    const raw = localStorage.getItem(CACHE_STORY_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveCachedStory(story) {
  localStorage.setItem(CACHE_STORY_KEY, JSON.stringify(story));
  localStorage.setItem(CACHE_STORY_TS_KEY, String(Date.now()));
}

function loadCachedStoryTimestamp() {
  const raw = localStorage.getItem(CACHE_STORY_TS_KEY);
  return raw ? parseInt(raw, 10) : null;
}

function loadCachedFingerprint() {
  try {
    const raw = localStorage.getItem(CACHE_FINGERPRINT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveCachedFingerprint(fp) {
  // fp: { learnedCount, stretchCount, level }
  localStorage.setItem(CACHE_FINGERPRINT_KEY, JSON.stringify(fp));
}

function loadCachedSubjects() {
  const ts = localStorage.getItem(CACHE_SUBJECTS_TS_KEY);
  if (!ts || Date.now() - parseInt(ts, 10) > SUBJECTS_TTL_MS) return null;
  try {
    const raw = localStorage.getItem(CACHE_SUBJECTS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveCachedSubjects(payload) {
  // payload: { learned: [...], stretch: [...], level: N }
  localStorage.setItem(CACHE_SUBJECTS_KEY, JSON.stringify(payload));
  localStorage.setItem(CACHE_SUBJECTS_TS_KEY, String(Date.now()));
}

// ── WaniKani API ───────────────────────────────────────────────────────────

async function wkFetch(token, url) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Wanikani-Revision': WK_REVISION,
    },
  });
  if (!res.ok) throw new Error(`WaniKani ${res.status}: ${res.statusText}`);
  return res.json();
}

async function fetchAllAssignments(token, onProgress) {
  const subjectIds = [];
  let url = `${WK_BASE}/assignments?srs_stages=1,2,3,4,5,6,7,8,9`;

  while (url) {
    const data = await wkFetch(token, url);
    for (const item of data.data) {
      const t = item.data.subject_type;
      if (t === 'kanji' || t === 'vocabulary') {
        subjectIds.push(item.data.subject_id);
      }
    }
    url = data.pages?.next_url || null;
    if (onProgress) onProgress(`Loading assignments… (${subjectIds.length} items so far)`);
  }

  return subjectIds;
}

async function fetchSubjects(token, ids, onProgress) {
  const subjects = [];
  const BATCH = 500;

  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const data = await wkFetch(token, `${WK_BASE}/subjects?ids=${batch.join(',')}`);
    subjects.push(...data.data);
    if (onProgress) onProgress(`Loading subjects… (${Math.min(i + BATCH, ids.length)}/${ids.length})`);
  }

  return subjects;
}

async function fetchUserLevel(token) {
  const data = await wkFetch(token, `${WK_BASE}/user`);
  return data.data.level;
}

async function fetchStretchSubjects(token, level, learnedIdSet) {
  const subjects = [];
  let url = `${WK_BASE}/subjects?types=vocabulary,kanji&levels=${level},${level + 1}`;

  while (url) {
    const data = await wkFetch(token, url);
    for (const item of data.data) {
      if (!learnedIdSet.has(item.id)) subjects.push(item);
    }
    url = data.pages?.next_url || null;
  }

  return subjects;
}

// ── Claude API ─────────────────────────────────────────────────────────────

async function generateStory(claudeKey, vocabWords, stretchWords) {
  const fmt = w => `${w.characters}（${w.meanings}）`;
  const knownList = sampleWords(vocabWords, 150).map(fmt).join('、');
  const stretchList = sampleWords(stretchWords, 30).map(fmt).join('、');

  const prompt = `You are a Japanese language teacher creating reading practice material for a beginner-intermediate learner.

Vocabulary pool (known words) — draw from these as needed:
${knownList}

Vocabulary pool (newer words to introduce) — weave in a few of these where they fit naturally:
${stretchList}

You are NOT required to use every word. Choose whichever words best serve the story. Prefer a smaller set of well-chosen words over shoehorning in many unrelated ones.

Write a short story in Japanese (2–3 paragraphs) following these rules:
- Before writing, decide on a single consistent setting, protagonist, and a simple goal or conflict
- The story must have a clear beginning, a small development or problem, and a resolution
- Each paragraph must follow logically from the previous one (cause → effect)
- Weave vocabulary into the narrative naturally; do not write a sentence solely to include a word
- Use particles (は、が、を、に、で、と、も、の、へ、から、まで、より) freely as needed for natural Japanese — they do not count toward vocabulary
- Verb tenses: present indicative, past indicative, present progressive, or past progressive only (plain or polite/keigo form; positive or negative are both fine)
- Do not use volitional, conditional, causative, passive, or potential verb forms
- Grammar complexity: N4–N5

Respond with ONLY valid JSON in this exact format:
{"japanese":"<full story in Japanese>","english":"<full English translation>","words_used":["word1","word2"],"readings":{"surface_form":"よみかた"}}

The "readings" object must include the hiragana reading for EVERY distinct kanji character and vocabulary word that appears in the story, keyed by its exact written form. Include standalone kanji, compound words, and verb forms.`;

  const res = await fetch(CLAUDE_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': claudeKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Claude API ${res.status}: ${err.error?.message || res.statusText}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text || '';

  // Strip markdown code fences if present
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error('Claude returned unexpected response format.');
  }
}

// ── Utilities ──────────────────────────────────────────────────────────────

function sampleWords(words, n) {
  if (words.length <= n) return words;
  const shuffled = [...words].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

function buildVocabList(subjects) {
  return subjects
    .filter(s => s.object === 'kanji' || s.object === 'vocabulary')
    .map(s => ({
      id: s.id,
      characters: s.data.characters,
      meanings: s.data.meanings
        .filter(m => m.primary)
        .map(m => m.meaning)
        .join(', '),
      reading: (s.data.readings || [])
        .filter(r => r.primary)
        .map(r => r.reading)
        .join('・') || '',
    }))
    .filter(w => w.characters && w.meanings);
}

function tokenizeStoryText(text, vocabMap, storyReadings = {}) {
  // Known/stretch keys, longest first
  const knownKeys = [...vocabMap.keys()].sort((a, b) => b.length - a.length);
  const knownEscaped = knownKeys.map(k => {
    const e = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Single kanji must not match as okurigana prefix (e.g. 来 inside 来ました)
    if (k.length === 1 && /[一-鿿㐀-䶿]/.test(k)) return e + '(?![ぁ-ゖ])';
    return e;
  });

  // Fallback: bare kanji run only — no trailing hiragana so particles are never swallowed
  const kanjiRun = '[一-鿿㐀-䶿々]+';

  const pattern = knownEscaped.length
    ? `(${knownEscaped.join('|')})|(${kanjiRun})`
    : `(?!)()|(${kanjiRun})`;
  const re = new RegExp(pattern, 'g');

  // Sort story.readings keys longest first for prefix lookup on unseen tokens
  const readingKeys = Object.keys(storyReadings).sort((a, b) => b.length - a.length);

  return text.replace(re, (match, knownHit, kanjiHit) => {
    if (knownHit) {
      const entry = vocabMap.get(knownHit);
      const reading = storyReadings[knownHit] || entry?.reading || '';
      const r = reading ? ` data-reading="${reading}"` : '';
      const cls = entry?.stretch ? 'vocab-token stretch' : 'vocab-token';
      return `<span class="${cls}"${r}>${knownHit}</span>`;
    }
    if (kanjiHit) {
      const reading = lookupUnseenReading(kanjiHit, storyReadings, readingKeys);
      const r = reading ? ` data-reading="${reading}"` : '';
      return `<span class="vocab-token unseen"${r}>${kanjiHit}</span>`;
    }
    return match;
  });
}

function lookupUnseenReading(text, storyReadings, sortedKeys) {
  if (storyReadings[text]) return storyReadings[text];
  for (const k of sortedKeys) {
    if (text.startsWith(k)) return storyReadings[k];
  }
  return '';
}

function shouldRegenerate(current, cached) {
  if (!cached) return true;
  if (current.level !== cached.level) return true;
  if (Math.abs(current.learnedCount - cached.learnedCount) >= FINGERPRINT_THRESHOLD) return true;
  if (Math.abs(current.stretchCount - cached.stretchCount) >= FINGERPRINT_THRESHOLD) return true;
  return false;
}

// ── UI helpers ─────────────────────────────────────────────────────────────

function renderTimestamp(ts) {
  const el = document.getElementById('story-timestamp');
  if (!ts) { el.textContent = ''; return; }
  const d = new Date(ts);
  el.textContent = 'Generated ' + d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(el => {
    el.classList.toggle('active', el.id === id);
    el.classList.toggle('hidden', el.id !== id);
  });
}

function setStatus(msg) {
  document.getElementById('loading-status').textContent = msg;
}

function showError(elementId, msg) {
  const el = document.getElementById(elementId);
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideError(elementId) {
  document.getElementById(elementId).classList.add('hidden');
}

function renderStory(story, vocabList, stretchList) {
  // Build vocab map for tokenization (stretch words marked for alternate styling)
  const vocabMap = new Map([
    ...vocabList.map(w => [w.characters, { reading: w.reading, stretch: false }]),
    ...stretchList.map(w => [w.characters, { reading: w.reading, stretch: true }]),
  ]);

  // Japanese text — split on。for paragraph breaks
  const jpEl = document.getElementById('story-japanese');
  const paragraphs = story.japanese
    .split(/(?<=。)/)
    .reduce((acc, sentence) => {
      if (!sentence.trim()) return acc;
      if (!acc.length || acc[acc.length - 1].endsWith('。')) {
        acc.push(sentence.trim());
      } else {
        acc[acc.length - 1] += sentence.trim();
      }
      return acc;
    }, []);

  // Group into paragraphs of roughly 2-3 sentences, then tokenize
  const chunkSize = 2;
  const chunks = [];
  for (let i = 0; i < paragraphs.length; i += chunkSize) {
    chunks.push(paragraphs.slice(i, i + chunkSize).join(''));
  }
  const storyReadings = story.readings || {};
  jpEl.innerHTML = chunks.map(p => `<p>${tokenizeStoryText(p, vocabMap, storyReadings)}</p>`).join('');

  // English text
  const enEl = document.getElementById('story-english');
  enEl.innerHTML = story.english
    .split(/\n+/)
    .filter(p => p.trim())
    .map(p => `<p>${p.trim()}</p>`)
    .join('');

  // Vocab list
  const usedWords = new Set(story.words_used || []);
  const listEl = document.getElementById('vocab-list');
  const displayWords = vocabList
    .filter(w => usedWords.has(w.characters))
    .slice(0, 50);

  if (displayWords.length === 0) {
    // Fall back to showing all sampled words if words_used wasn't populated well
    listEl.innerHTML = '';
  } else {
    listEl.innerHTML = displayWords
      .map(w => `<li><span class="vocab-word">${w.characters}</span><span class="vocab-meaning">${w.meanings}</span></li>`)
      .join('');
  }
}

// ── Reading popup ──────────────────────────────────────────────────────────

function initReadingPopup() {
  const popup = document.getElementById('reading-popup');
  let activeToken = null;

  document.getElementById('story-japanese').addEventListener('click', e => {
    const token = e.target.closest('.vocab-token');
    if (!token) {
      hidePopup();
      return;
    }
    if (token === activeToken) {
      hidePopup();
      return;
    }
    activeToken = token;
    popup.querySelector('.popup-word').textContent = token.textContent;
    popup.querySelector('.popup-reading').textContent = token.dataset.reading || '';
    positionPopup(popup, token);
    popup.classList.add('visible');
    e.stopPropagation();
  });

  document.addEventListener('click', () => hidePopup());

  function hidePopup() {
    popup.classList.remove('visible');
    activeToken = null;
  }

  function positionPopup(popup, token) {
    popup.style.visibility = 'hidden';
    popup.style.display = 'flex';
    const rect = token.getBoundingClientRect();
    const pw = popup.offsetWidth || 160;
    const ph = popup.offsetHeight || 80;
    popup.style.visibility = '';
    popup.style.display = '';

    let left = rect.left;
    let top = rect.bottom + 8;

    // Clamp horizontally
    left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
    // Flip above if too close to bottom
    if (top + ph > window.innerHeight - 8) {
      top = rect.top - ph - 8;
    }

    popup.style.left = left + 'px';
    popup.style.top = top + 'px';
  }
}

// ── Translation toggle ─────────────────────────────────────────────────────

let translationVisible = false;

function toggleTranslation() {
  translationVisible = !translationVisible;
  document.getElementById('story-english').classList.toggle('hidden', !translationVisible);
  document.getElementById('btn-translation').textContent = translationVisible
    ? 'Hide Translation'
    : 'Show Translation';
}

// ── Main flow ──────────────────────────────────────────────────────────────

async function run(wkToken, claudeKey, forceRegenerate = false) {
  showScreen('screen-loading');
  hideError('story-error');

  try {
    // 1. Load subjects (with 24h cache)
    let cache = loadCachedSubjects();
    // Invalidate old-format cache (was a plain array before the 80/20 update)
    if (cache && (!cache.learned || !cache.stretch || cache.level == null)) cache = null;
    let learnedSubjects, stretchSubjects, userLevel;

    if (!cache) {
      setStatus('Fetching your WaniKani profile…');
      userLevel = await fetchUserLevel(wkToken);

      setStatus('Fetching your assignments from WaniKani…');
      const subjectIds = await fetchAllAssignments(wkToken, setStatus);
      const learnedIdSet = new Set(subjectIds);

      setStatus('Fetching subject details…');
      learnedSubjects = await fetchSubjects(wkToken, subjectIds, setStatus);

      setStatus('Fetching stretch vocabulary…');
      stretchSubjects = await fetchStretchSubjects(wkToken, userLevel, learnedIdSet);

      saveCachedSubjects({ learned: learnedSubjects, stretch: stretchSubjects, level: userLevel });
    } else {
      learnedSubjects = cache.learned;
      stretchSubjects = cache.stretch;
      userLevel = cache.level;
    }

    const vocabList = buildVocabList(learnedSubjects);
    const stretchList = buildVocabList(stretchSubjects);

    if (vocabList.length === 0) {
      throw new Error('No kanji or vocabulary found at Apprentice level or above. Keep studying and try again!');
    }

    // 2. Check fingerprint cache
    const cachedFp = loadCachedFingerprint();
    const currentFp = { learnedCount: vocabList.length, stretchCount: stretchList.length, level: userLevel };
    const needsNew = forceRegenerate || shouldRegenerate(currentFp, cachedFp);

    let story = needsNew ? null : loadCachedStory();

    if (!story) {
      setStatus('Generating your story with Claude…');
      story = await generateStory(claudeKey, vocabList, stretchList);
      saveCachedStory(story);
      saveCachedFingerprint(currentFp);
    }

    // 3. Render
    renderStory(story, vocabList, stretchList);
    renderTimestamp(loadCachedStoryTimestamp());
    translationVisible = false;
    document.getElementById('story-english').classList.add('hidden');
    document.getElementById('btn-translation').textContent = 'Show Translation';
    showScreen('screen-story');

  } catch (err) {
    console.error(err);
    // If story screen is already up, show error there
    if (!document.getElementById('screen-story').classList.contains('hidden')) {
      showError('story-error', err.message);
    } else {
      showError('setup-error', err.message);
      showScreen('screen-setup');
    }
  }
}

// ── Event listeners ────────────────────────────────────────────────────────

document.getElementById('setup-form').addEventListener('submit', async e => {
  e.preventDefault();
  hideError('setup-error');

  const wkToken = document.getElementById('wk-token').value.trim();
  const claudeKey = document.getElementById('claude-key').value.trim();

  if (!wkToken || !claudeKey) {
    showError('setup-error', 'Both fields are required.');
    return;
  }

  saveSettings(wkToken, claudeKey);
  await run(wkToken, claudeKey);
});

document.getElementById('btn-translation').addEventListener('click', toggleTranslation);

document.getElementById('btn-new-story').addEventListener('click', async () => {
  const { wkToken, claudeKey } = loadSettings();
  await run(wkToken, claudeKey, true);
});

document.getElementById('btn-settings').addEventListener('click', () => {
  showScreen('screen-setup');
  const { wkToken, claudeKey } = loadSettings();
  document.getElementById('wk-token').value = wkToken;
  document.getElementById('claude-key').value = claudeKey;
});

// ── Auto-start if credentials exist ───────────────────────────────────────

initReadingPopup();

(function init() {
  const { wkToken, claudeKey } = loadSettings();
  if (wkToken && claudeKey) {
    run(wkToken, claudeKey);
  } else {
    showScreen('screen-setup');
    // Pre-fill if partial
    if (wkToken) document.getElementById('wk-token').value = wkToken;
    if (claudeKey) document.getElementById('claude-key').value = claudeKey;
  }
})();
