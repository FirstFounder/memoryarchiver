function buildChargeWindowHours(windowStartHour, targetHour) {
  const hours = [];
  let hour = windowStartHour;

  do {
    hours.push(hour);
    hour = (hour + 1) % 24;
  } while (hour !== targetHour);

  return hours;
}

function extractChicagoHour(timestamp) {
  // Open-Meteo returns strings like "2026-04-17T22:00" in the requested timezone.
  // Characters 11–12 are always the hour when the value is an ISO string.
  // If for any reason a numeric epoch arrives, convert it via Intl to stay in CT.
  if (typeof timestamp === 'string') {
    return Number(timestamp.slice(11, 13));
  }
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    hour12: false,
  }).format(new Date(timestamp)));
}

export async function fetchOvernightLow(lat, lon, windowStartHour, targetHour) {
  try {
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude', String(lat));
    url.searchParams.set('longitude', String(lon));
    url.searchParams.set('hourly', 'temperature_2m');
    url.searchParams.set('temperature_unit', 'fahrenheit');
    url.searchParams.set('timezone', 'America/Chicago');
    url.searchParams.set('forecast_days', '2');

    const response = await fetch(url);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Open-Meteo request failed: ${response.status} ${text}`);
    }

    const payload = JSON.parse(text);
    const hourlyTimes = payload?.hourly?.time;
    const hourlyTemps = payload?.hourly?.temperature_2m;
    if (
      !Array.isArray(hourlyTimes)
      || !Array.isArray(hourlyTemps)
      || hourlyTimes.length !== hourlyTemps.length
    ) {
      throw new Error('Open-Meteo response missing hourly temperatures');
    }

    const windowHours = new Set(buildChargeWindowHours(windowStartHour, targetHour));
    const overnightTemps = [];

    for (let index = 0; index < hourlyTimes.length; index += 1) {
      const temp = Number(hourlyTemps[index]);
      if (!Number.isFinite(temp)) continue;

      const hour = extractChicagoHour(hourlyTimes[index]);
      if (windowHours.has(hour)) {
        overnightTemps.push(temp);
      }
    }

    return overnightTemps.length ? Math.min(...overnightTemps) : 35;
  } catch {
    return 35;
  }
}

export async function fetchRideWeather(lat, lon) {
  try {
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude', String(lat));
    url.searchParams.set('longitude', String(lon));
    url.searchParams.set('current', 'temperature_2m,windspeed_10m,winddirection_10m');
    url.searchParams.set('temperature_unit', 'fahrenheit');
    url.searchParams.set('windspeed_unit', 'mph');
    url.searchParams.set('timezone', 'auto');
    const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) return null;
    const data = await response.json();
    const current = data?.current;
    if (!current) return null;
    return {
      temp_f:          current.temperature_2m       ?? null,
      wind_speed_mph:  current.windspeed_10m         ?? null,
      wind_dir_deg:    current.winddirection_10m     ?? null,
    };
  } catch {
    return null;
  }
}
