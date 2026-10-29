/**
 * WeatherNow — Asynchronous JavaScript & RESTful API Integration
 * ================================================================
 * Features:
 *  - Fetch API + async/await for non-blocking data retrieval
 *  - Comprehensive error handling (network, 404, rate-limit)
 *  - Complex nested JSON parsing from wttr.in
 *  - Dynamic DOM rendering (no page reloads)
 *  - City search + Enter-key support
 *  - Recent searches persisted in localStorage
 *  - Geolocation auto-detect on page load
 *  - Light/Dark theme toggle persisted in localStorage
 *  - Debounced input handling
 *  - Loading and error states
 *
 * API: https://wttr.in/{city}?format=j1  (no key, CORS-enabled)
 * ================================================================
 * Author: ramprasathb705-web
 */

'use strict';

/* ── Constants ──────────────────────────────────────────── */

/** Base URL for wttr.in JSON API */
const WTTR_API = 'https://wttr.in';

/** localStorage keys */
const LS_THEME   = 'weathernow_theme';
const LS_RECENT  = 'weathernow_recent';

/** Maximum recent searches to remember */
const MAX_RECENT = 6;

/** Debounce delay in milliseconds */
const DEBOUNCE_MS = 400;

/* ── DOM References ─────────────────────────────────────── */

const $ = (id) => document.getElementById(id);

const searchForm      = $('search-form');
const cityInput       = $('city-input');
const themeToggle     = $('theme-toggle');
const geoBtn          = $('geo-btn');
const loadingOverlay  = $('loading-overlay');
const errorCard       = $('error-card');
const errorMessage    = $('error-message');
const errorRetry      = $('error-retry');
const weatherDash     = $('weather-dashboard');
const emptyState      = $('empty-state');
const recentSearches  = $('recent-searches');
const recentList      = $('recent-list');
const themeIcon       = themeToggle.querySelector('.theme-icon');

// Weather display elements
const wCity       = $('w-city');
const wCountry    = $('w-country');
const wDate       = $('w-date');
const wDesc       = $('w-desc');
const wIcon       = $('w-icon');
const wTemp       = $('w-temp');
const mFeels      = $('m-feels');
const mHumidity   = $('m-humidity');
const mWind       = $('m-wind');
const mVisibility = $('m-visibility');
const mUv         = $('m-uv');
const mCloud      = $('m-cloud');
const forecastStrip = $('forecast-strip');

/* ── State ──────────────────────────────────────────────── */

let lastCity = '';         // most recent successful city search
let retryCity = '';        // city to retry if user clicks "Try Again"
let debounceTimer = null;  // timer handle for debounce

/* ──────────────────────────────────────────────────────────
   SECTION 1: Theme Management
   ────────────────────────────────────────────────────────── */

/**
 * Applies the given theme ('dark' | 'light') to the document
 * and updates the toggle button state.
 * @param {string} theme
 */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(LS_THEME, theme);

  const isDark = theme === 'dark';
  themeIcon.textContent = isDark ? '☀️' : '🌙';
  themeToggle.setAttribute('aria-pressed', String(!isDark));
  themeToggle.setAttribute(
    'aria-label',
    isDark ? 'Switch to light theme' : 'Switch to dark theme'
  );
}

/** Toggles between dark and light themes. */
function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

/* ──────────────────────────────────────────────────────────
   SECTION 2: Recent Searches (localStorage)
   ────────────────────────────────────────────────────────── */

/**
 * Retrieves the saved recent searches array from localStorage.
 * @returns {string[]}
 */
function getRecentSearches() {
  try {
    return JSON.parse(localStorage.getItem(LS_RECENT)) || [];
  } catch {
    return [];
  }
}

/**
 * Saves a city to the recent searches list (most recent first,
 * deduped, capped at MAX_RECENT).
 * @param {string} city
 */
function saveRecentSearch(city) {
  const normalized = city.trim();
  if (!normalized) return;

  let recents = getRecentSearches().filter(
    (c) => c.toLowerCase() !== normalized.toLowerCase()
  );
  recents.unshift(normalized);
  recents = recents.slice(0, MAX_RECENT);
  localStorage.setItem(LS_RECENT, JSON.stringify(recents));
}

/**
 * Renders the recent-searches chip list from localStorage.
 * Shows the nav if there are recents, hides it if empty.
 */
function renderRecentSearches() {
  const recents = getRecentSearches();

  if (recents.length === 0) {
    recentSearches.hidden = true;
    return;
  }

  recentSearches.hidden = false;
  recentList.innerHTML = '';

  recents.forEach((city) => {
    const li   = document.createElement('li');
    const btn  = document.createElement('button');
    btn.type          = 'button';
    btn.className     = 'recent-chip';
    btn.textContent   = city;
    btn.setAttribute('aria-label', `Search weather for ${city}`);

    btn.addEventListener('click', () => {
      cityInput.value = city;
      fetchWeather(city);
    });

    li.appendChild(btn);
    recentList.appendChild(li);
  });
}

/* ──────────────────────────────────────────────────────────
   SECTION 3: UI State Helpers
   ────────────────────────────────────────────────────────── */

/** Shows the loading spinner and hides other content areas. */
function showLoading() {
  loadingOverlay.hidden  = false;
  errorCard.hidden       = true;
  weatherDash.hidden     = true;
  emptyState.hidden      = true;
}

/** Hides the loading spinner. */
function hideLoading() {
  loadingOverlay.hidden = true;
}

/**
 * Shows the error card with a descriptive message.
 * @param {string} message
 */
function showError(message) {
  hideLoading();
  errorMessage.textContent = message;
  errorCard.hidden         = false;
  weatherDash.hidden       = true;
  emptyState.hidden        = true;
  errorCard.focus?.();
}

/** Shows the weather dashboard and hides other states. */
function showDashboard() {
  hideLoading();
  weatherDash.hidden = false;
  errorCard.hidden   = true;
  emptyState.hidden  = true;
}

/* ──────────────────────────────────────────────────────────
   SECTION 4: Async Fetch & Error Handling
   ────────────────────────────────────────────────────────── */

/**
 * Fetches weather data from wttr.in for a given city.
 * Uses async/await with comprehensive try/catch error handling.
 *
 * wttr.in JSON format (j1):
 *   current_condition[0]: temp_C, FeelsLikeC, humidity,
 *     windspeedKmph, visibility, uvIndex, cloudcover,
 *     weatherDesc[0].value, weatherIconUrl[0].value
 *   weather[0..2]: date, maxtempC, mintempC,
 *     hourly[4]: weatherDesc[0].value, weatherIconUrl[0].value
 *   nearest_area[0]: areaName[0].value, country[0].value
 *
 * @param {string} city  - City name to search
 */
async function fetchWeather(city) {
  const trimmed = city.trim();
  if (!trimmed) {
    cityInput.focus();
    return;
  }

  retryCity = trimmed;
  showLoading();

  try {
    // ── Build URL — wttr.in requires URL encoding ──────────
    const url = `${WTTR_API}/${encodeURIComponent(trimmed)}?format=j1`;

    // ── Fetch with timeout (8 seconds) ───────────────────
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), 8000);

    let response;
    try {
      response = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }

    // ── HTTP error handling ───────────────────────────────
    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`City "${trimmed}" was not found. Please check the spelling and try again.`);
      } else if (response.status === 429) {
        throw new Error('Too many requests. Please wait a moment and try again.');
      } else if (response.status >= 500) {
        throw new Error('The weather service is temporarily unavailable. Please try again later.');
      } else {
        throw new Error(`Unexpected error (HTTP ${response.status}). Please try again.`);
      }
    }

    // ── Parse JSON ───────────────────────────────────────
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error('Received invalid data from the weather service. Please try again.');
    }

    // ── Validate expected structure ───────────────────────
    if (
      !data?.current_condition?.[0] ||
      !data?.nearest_area?.[0] ||
      !data?.weather?.[0]
    ) {
      throw new Error(`No weather data found for "${trimmed}". Try a different city name.`);
    }

    // ── Success: render & save ────────────────────────────
    renderWeather(data, trimmed);
    saveRecentSearch(trimmed);
    renderRecentSearches();
    lastCity = trimmed;

  } catch (err) {
    // ── Distinguish abort (timeout) vs other errors ───────
    if (err.name === 'AbortError') {
      showError('The request timed out. Check your internet connection and try again.');
    } else if (err.name === 'TypeError') {
      // TypeError from fetch usually means network failure
      showError('Network error — please check your internet connection and try again.');
    } else {
      showError(err.message || 'An unknown error occurred. Please try again.');
    }
  }
}

/* ──────────────────────────────────────────────────────────
   SECTION 5: JSON Parsing & Dynamic DOM Rendering
   ────────────────────────────────────────────────────────── */

/**
 * Safely reads a nested value from the wttr.in response.
 * Returns `fallback` if any step in the chain is undefined/null.
 *
 * @param {*}      obj       - Root object
 * @param {string} path      - Dot-notation path: 'a.b.0.c'
 * @param {*}      [fallback] - Value if path is missing
 * @returns {*}
 */
function dig(obj, path, fallback = '—') {
  return path.split('.').reduce((acc, key) => {
    if (acc === null || acc === undefined) return fallback;
    const val = acc[key];
    return val !== undefined && val !== null && val !== '' ? val : fallback;
  }, obj);
}

/**
 * Returns a human-readable, locale-formatted date string.
 * @param {string} dateStr  - 'YYYY-MM-DD'
 * @param {boolean} [short] - Use abbreviated weekday
 * @returns {string}
 */
function formatDate(dateStr, short = false) {
  if (!dateStr || dateStr === '—') return '—';
  try {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString(undefined, {
      weekday: short ? 'short' : 'long',
      month:   'long',
      day:     'numeric',
    });
  } catch {
    return dateStr;
  }
}

/**
 * Parses the wttr.in JSON response and updates all DOM elements
 * to display the current weather and 3-day forecast.
 *
 * @param {Object} data   - Parsed JSON from wttr.in ?format=j1
 * @param {string} query  - Original search query (fallback for city name)
 */
function renderWeather(data, query) {
  /* ── Extract nested data ─────────────────────────────── */

  const current = data.current_condition[0];
  const area    = data.nearest_area[0];

  const cityName    = dig(area,    'areaName.0.value',  query);
  const countryName = dig(area,    'country.0.value',   '—');
  const temp        = dig(current, 'temp_C',            '—');
  const feelsLike   = dig(current, 'FeelsLikeC',       '—');
  const humidity    = dig(current, 'humidity',          '—');
  const windKmph    = dig(current, 'windspeedKmph',     '—');
  const visibility  = dig(current, 'visibility',        '—');
  const uvIndex     = dig(current, 'uvIndex',           '—');
  const cloudCover  = dig(current, 'cloudcover',        '—');
  const desc        = dig(current, 'weatherDesc.0.value', 'N/A');
  const iconUrl     = dig(current, 'weatherIconUrl.0.value', '');

  /* ── Update hero card ─────────────────────────────────── */

  wCity.textContent    = cityName;
  wCountry.textContent = countryName;
  wDate.textContent    = new Date().toLocaleDateString(undefined, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  wDesc.textContent    = desc;
  wTemp.textContent    = temp;

  if (iconUrl && iconUrl !== '—') {
    wIcon.src = iconUrl.startsWith('//') ? 'https:' + iconUrl : iconUrl;
    wIcon.alt = `Weather condition: ${desc}`;
    wIcon.hidden = false;
  } else {
    wIcon.hidden = true;
  }

  /* ── Update metric cards ─────────────────────────────── */

  mFeels.textContent      = feelsLike !== '—' ? `${feelsLike}°C`  : '—';
  mHumidity.textContent   = humidity  !== '—' ? `${humidity}%`    : '—';
  mWind.textContent       = windKmph  !== '—' ? `${windKmph} km/h`: '—';
  mVisibility.textContent = visibility!== '—' ? `${visibility} km`: '—';
  mUv.textContent         = uvIndex   !== '—' ? `${uvIndex}`       : '—';
  mCloud.textContent      = cloudCover!== '—' ? `${cloudCover}%`   : '—';

  /* ── Render 3-day forecast ───────────────────────────── */

  forecastStrip.innerHTML = '';   // clear previous cards

  // wttr.in provides weather[0], weather[1], weather[2] = today + 2 days
  const days = data.weather.slice(0, 3);

  days.forEach((day, idx) => {
    const dayDate  = dig(day, 'date',               '—');
    const maxTemp  = dig(day, 'maxtempC',            '—');
    const minTemp  = dig(day, 'mintempC',            '—');

    // Noon hourly slot (index 4 of 8 three-hourly slots) for icon & desc
    const hourly   = day.hourly?.[4] || day.hourly?.[0] || {};
    const dayDesc  = dig(hourly, 'weatherDesc.0.value', 'N/A');
    const dayIcon  = dig(hourly, 'weatherIconUrl.0.value', '');

    /* Build forecast card */
    const article = document.createElement('article');
    article.className = 'forecast-card card';
    article.setAttribute('role', 'listitem');
    article.setAttribute(
      'aria-label',
      `${idx === 0 ? 'Today' : formatDate(dayDate, true)}: High ${maxTemp}°C, Low ${minTemp}°C, ${dayDesc}`
    );

    const label = idx === 0 ? 'Today' : formatDate(dayDate, true);

    let iconHTML = '';
    if (dayIcon && dayIcon !== '—') {
      const src = dayIcon.startsWith('//') ? 'https:' + dayIcon : dayIcon;
      iconHTML = `<img class="fc-icon" src="${src}" alt="${dayDesc}" width="52" height="52" loading="lazy" />`;
    } else {
      iconHTML = `<span class="fc-icon" style="font-size:2.5rem;line-height:1" aria-hidden="true">🌤️</span>`;
    }

    article.innerHTML = `
      <p class="fc-day">${label}</p>
      ${iconHTML}
      <p class="fc-desc">${dayDesc}</p>
      <div class="fc-temps">
        <span class="fc-high">${maxTemp !== '—' ? maxTemp + '°' : '—'}</span>
        <span class="fc-low">${minTemp !== '—' ? minTemp + '°' : '—'}</span>
      </div>
    `;

    forecastStrip.appendChild(article);
  });

  /* ── Show dashboard ───────────────────────────────────── */
  showDashboard();

  // Update page title with city
  document.title = `${cityName} Weather — WeatherNow`;
}

/* ──────────────────────────────────────────────────────────
   SECTION 6: Geolocation
   ────────────────────────────────────────────────────────── */

/**
 * Uses the browser Geolocation API to get the user's coordinates,
 * then fetches weather using the lat,lon format that wttr.in supports.
 */
async function useGeolocation() {
  if (!navigator.geolocation) {
    showError('Geolocation is not supported by your browser.');
    return;
  }

  showLoading();

  navigator.geolocation.getCurrentPosition(
    // ── Success callback ──────────────────────────────────
    async (position) => {
      const { latitude, longitude } = position.coords;
      // wttr.in accepts "lat,lon" as the city parameter
      const coords = `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
      await fetchWeather(coords);
    },
    // ── Error callback ────────────────────────────────────
    (geoError) => {
      const messages = {
        1: 'Location access was denied. Please enable location permissions in your browser.',
        2: 'Could not determine your location. Try searching manually.',
        3: 'Location request timed out. Please try again or search manually.',
      };
      showError(messages[geoError.code] || 'Unable to retrieve your location.');
    },
    { timeout: 10000, maximumAge: 60000 }
  );
}

/* ──────────────────────────────────────────────────────────
   SECTION 7: Debounce Utility
   ────────────────────────────────────────────────────────── */

/**
 * Creates a debounced version of a function that delays invocation
 * until after `delay` milliseconds have elapsed since the last call.
 *
 * @param {Function} fn
 * @param {number}   delay
 * @returns {Function}
 */
function debounce(fn, delay) {
  return function (...args) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => fn.apply(this, args), delay);
  };
}

/* ──────────────────────────────────────────────────────────
   SECTION 8: Event Listeners
   ────────────────────────────────────────────────────────── */

/** Search form submission (button click or Enter key) */
searchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  fetchWeather(cityInput.value);
});

/** Theme toggle button */
themeToggle.addEventListener('click', toggleTheme);

/** Geolocation button */
geoBtn.addEventListener('click', useGeolocation);

/** "Try Again" button on the error card */
errorRetry.addEventListener('click', () => {
  if (retryCity) {
    fetchWeather(retryCity);
  }
});

/**
 * Optional: live debounced search as user types
 * (fires when at least 3 chars are entered and no change for DEBOUNCE_MS ms)
 */
cityInput.addEventListener(
  'input',
  debounce(() => {
    const value = cityInput.value.trim();
    if (value.length >= 3) {
      fetchWeather(value);
    }
  }, DEBOUNCE_MS)
);

/* ──────────────────────────────────────────────────────────
   SECTION 9: Initialisation
   ────────────────────────────────────────────────────────── */

/**
 * Bootstraps the application on DOMContentLoaded:
 *  1. Restores saved theme preference
 *  2. Renders recent search chips
 *  3. Optionally auto-loads last searched city
 */
function init() {
  // 1. Restore theme
  const savedTheme = localStorage.getItem(LS_THEME) || 'dark';
  applyTheme(savedTheme);

  // 2. Render recent search chips
  renderRecentSearches();

  // 3. Auto-load last city if available (good UX on revisit)
  const recents = getRecentSearches();
  if (recents.length > 0) {
    const lastSearchedCity = recents[0];
    cityInput.value = lastSearchedCity;
    fetchWeather(lastSearchedCity);
  }
}

// ── Boot ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
