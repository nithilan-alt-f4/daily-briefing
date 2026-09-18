/**
 * weather.js — Client-side weather fetch (Open-Meteo + wttr.in fallback).
 * Extracted from server-side src/routes/api.js weather endpoint.
 * Same response shape so existing renderWeatherFull/renderWeatherStrip work unchanged.
 *
 * Exposes window.WeatherAPI globally.
 */
(function () {
  'use strict';

  var CFG = window.AppConfig;
  var WMO = function (code) {
    return ({
      0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
      45: 'Fog', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
      56: 'Freezing drizzle', 57: 'Freezing drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
      66: 'Freezing rain', 67: 'Freezing rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
      77: 'Snow grains', 80: 'Light showers', 81: 'Showers', 82: 'Heavy showers',
      85: 'Snow showers', 86: 'Snow showers', 95: 'Thunderstorm', 96: 'Storm with hail', 99: 'Storm with hail'
    })[code] || 'Unknown';
  };

  var DIR_NAME = function (deg) {
    return ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'][Math.round(deg / 22.5) % 16];
  };

  function wttrToWmo(code) {
    var c = parseInt(code, 10);
    if (c === 113) return 0;
    if (c === 116) return 1;
    if (c === 119 || c === 122) return 3;
    if (c === 143 || c === 248 || c === 260) return 45;
    if (c === 176) return 51;
    if (c === 263 || c === 266) return 53;
    if (c === 281 || c === 284) return 56;
    if (c === 293 || c === 296) return 61;
    if (c === 299 || c === 302) return 63;
    if (c === 305 || c === 308) return 65;
    if (c === 311 || c === 314 || c === 353 || c === 356) return 80;
    if (c === 359 || c === 386) return 95;
    return 3;
  }

  function mapWttrToResult(d) {
    var cur = d.current_condition[0];
    var today = d.weather[0];

    var hourly = [];
    for (var di = 0; di < d.weather.length; di++) {
      var day = d.weather[di];
      var hs = day.hourly || [];
      for (var hi = 0; hi < hs.length; hi++) {
        var h = hs[hi];
        var hh = parseInt(h.time, 10) / 100;
        var date = day.date;
        var time = date + 'T' + String(hh).padStart(2, '0') + ':00';
        hourly.push({
          time: time,
          temp: Math.round(+h.tempC),
          feels: Math.round(+h.FeelsLikeC),
          humidity: +h.humidity,
          rainChance: +h.chanceofrain,
          rain: +h.precipMM,
          code: wttrToWmo(h.weatherCode),
          condition: WMO(wttrToWmo(h.weatherCode)),
          wind: +h.windspeedKmph,
          gusts: +h.WindGustKmph,
          uv: +h.uvIndex,
          visibility: +h.visibility
        });
      }
    }
    var istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    var nowIso = istNow.toISOString().slice(0, 13);
    var next24 = hourly.filter(function (h) { return h.time >= nowIso; }).slice(0, 24);

    var daily = d.weather.map(function (day) {
      var astro = (day.astronomy && day.astronomy[0]) || {};
      var hs = day.hourly || [];
      var code = wttrToWmo((hs[4] && hs[4].weatherCode) || (hs[0] && hs[0].weatherCode) || '116');
      var temps = hs.map(function (h) { return +h.tempC; });
      var feels = hs.map(function (h) { return +h.FeelsLikeC; });
      var rains = hs.map(function (h) { return +h.chanceofrain; });
      var uvArr = hs.map(function (h) { return +h.uvIndex; });
      var windArr = hs.map(function (h) { return +h.windspeedKmph; });
      return {
        date: day.date,
        code: code,
        condition: WMO(code),
        max: temps.length ? Math.round(Math.max.apply(null, temps)) : 0,
        min: temps.length ? Math.round(Math.min.apply(null, temps)) : 0,
        feelsMax: feels.length ? Math.round(Math.max.apply(null, feels)) : 0,
        feelsMin: feels.length ? Math.round(Math.min.apply(null, feels)) : 0,
        sunrise: day.date + 'T' + astro.sunrise,
        sunset: day.date + 'T' + astro.sunset,
        uvMax: uvArr.length ? Math.round(Math.max.apply(null, uvArr)) : 0,
        rainSum: hs.reduce(function (s, h) { return s + +h.precipMM; }, 0),
        rainChance: rains.length ? Math.max.apply(null, rains.map(function (r) { return Math.max(0, r); })) : 0,
        windMax: windArr.length ? Math.max.apply(null, windArr) : 0
      };
    });

    return {
      source: 'wttr.in',
      location: 'Yelahanka, Bangalore',
      updated: new Date().toISOString(),
      current: {
        temp: Math.round(+cur.temp_C),
        feels: Math.round(+cur.FeelsLikeC),
        humidity: +cur.humidity,
        condition: WMO(wttrToWmo(cur.weatherCode)),
        code: wttrToWmo(cur.weatherCode),
        rain: +cur.precipMM,
        cloud: +cur.cloudcover,
        pressure: +cur.pressure,
        wind: +cur.windspeedKmph,
        windDir: cur.winddir16Point,
        windDeg: +cur.winddirDegree,
        gusts: Math.round(+cur.WindGustKmph || +cur.windspeedKmph)
      },
      today: daily[0],
      hourly: next24,
      daily: daily
    };
  }

  var cache = { data: null, at: 0 };
  var CACHE_TTL = 60 * 60 * 1000; // 1 hour

  function fetchWeather() {
    // Return cache if fresh
    if (cache.data && Date.now() - cache.at < CACHE_TTL) {
      return Promise.resolve(cache.data);
    }

    var lat = CFG.LAT;
    var lon = CFG.LON;
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon +
      '&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,cloud_cover,pressure_msl,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m' +
      '&hourly=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,uv_index,visibility' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,sunrise,sunset,uv_index_max,precipitation_sum,precipitation_probability_max,wind_speed_10m_max' +
      '&timezone=auto&forecast_days=7';

    // Try Open-Meteo first
    return fetch(url, { signal: AbortSignal.timeout(8000) })
      .then(function (r) {
        if (r.status === 429) throw new Error('rate-limited');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        if (!data.current) throw new Error('bad response');
        return parseOpenMeteo(data);
      })
      .catch(function () {
        // Open-Meteo failed → wttr.in fallback
        return fetch('https://wttr.in/Yelahanka?format=j1', { signal: AbortSignal.timeout(15000) })
          .then(function (wr) {
            if (!wr.ok) throw new Error('wttr.in HTTP ' + wr.status);
            return wr.json();
          })
          .then(function (wjson) {
            return mapWttrToResult(wjson);
          });
      })
      .then(function (result) {
        cache.data = result;
        cache.at = Date.now();
        return result;
      });
  }

  function parseOpenMeteo(data) {
    var istNowH = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    var nowIso = istNowH.toISOString().slice(0, 13);

    var hourly = data.hourly.time.map(function (t, i) {
      return {
        time: t,
        temp: Math.round(data.hourly.temperature_2m[i]),
        feels: Math.round(data.hourly.apparent_temperature[i]),
        humidity: data.hourly.relative_humidity_2m[i],
        rainChance: data.hourly.precipitation_probability[i],
        rain: data.hourly.precipitation[i],
        code: data.hourly.weather_code[i],
        condition: WMO(data.hourly.weather_code[i]),
        wind: Math.round(data.hourly.wind_speed_10m[i]),
        gusts: Math.round(data.hourly.wind_gusts_10m[i]),
        uv: data.hourly.uv_index[i],
        visibility: data.hourly.visibility[i]
      };
    });
    var next24 = hourly.filter(function (h) { return h.time >= nowIso; }).slice(0, 24);

    var daily = data.daily.time.map(function (t, i) {
      return {
        date: t,
        code: data.daily.weather_code[i],
        condition: WMO(data.daily.weather_code[i]),
        max: Math.round(data.daily.temperature_2m_max[i]),
        min: Math.round(data.daily.temperature_2m_min[i]),
        feelsMax: Math.round(data.daily.apparent_temperature_max[i]),
        feelsMin: Math.round(data.daily.apparent_temperature_min[i]),
        sunrise: data.daily.sunrise[i],
        sunset: data.daily.sunset[i],
        uvMax: Math.round(data.daily.uv_index_max[i]),
        rainSum: data.daily.precipitation_sum[i],
        rainChance: data.daily.precipitation_probability_max[i],
        windMax: Math.round(data.daily.wind_speed_10m_max[i])
      };
    });

    var c = data.current;
    return {
      source: 'open-meteo',
      location: 'Yelahanka, Bangalore',
      updated: new Date().toISOString(),
      current: {
        temp: Math.round(c.temperature_2m),
        feels: Math.round(c.apparent_temperature),
        humidity: c.relative_humidity_2m,
        condition: WMO(c.weather_code),
        code: c.weather_code,
        isDay: c.is_day === 1,
        rain: c.precipitation,
        cloud: c.cloud_cover,
        pressure: Math.round(c.pressure_msl),
        wind: Math.round(c.wind_speed_10m),
        windDir: DIR_NAME(c.wind_direction_10m),
        windDeg: c.wind_direction_10m,
        gusts: Math.round(c.wind_gusts_10m)
      },
      today: daily[0],
      hourly: next24,
      daily: daily
    };
  }

  window.WeatherAPI = { fetch: fetchWeather };
})();
