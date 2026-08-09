/**
 * Weather.gov API client — fetches current conditions for US venues.
 *
 * Free, no API key required. Two-step lookup:
 *   1. /points/{lat},{lon} → gridpoint + forecast office
 *   2. /gridpoints/{office}/{gridX},{gridY}/forecast/hourly → hourly forecast
 *
 * For SPOTTER, we care about conditions that could delay an outdoor event:
 * rain, lightning, extreme heat, extreme cold, high winds.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WeatherConditions {
  /** Current temperature in °F */
  temperatureF: number;

  /** Feels-like temperature in °F (wind chill or heat index) */
  feelsLikeF: number;

  /** Wind speed in mph */
  windSpeedMph: number;

  /** Wind direction, e.g. "NW" */
  windDirection: string;

  /** Short forecast text, e.g. "Partly Cloudy", "Thunderstorms" */
  shortForecast: string;

  /** Probability of precipitation (0-100) */
  precipChance: number;

  /** Whether conditions could cause a delay */
  delayRisk: DelayRisk;

  /** Human-readable summary of delay risk */
  delayDetail: string;

  /** Timestamp of the forecast period */
  forecastTime: string;
}

export type DelayRisk = 'none' | 'low' | 'moderate' | 'high';

// ---------------------------------------------------------------------------
// Geocoding — venue city/state to lat/lon
// ---------------------------------------------------------------------------

/**
 * Known venue coordinates. We hardcode the major ones rather than hitting
 * a geocoding API. If a venue isn't here, we skip weather monitoring.
 */
const VENUE_COORDS: Record<string, [number, number]> = {
  // MLB outdoor parks
  'yankee stadium': [40.8296, -73.9262],
  'citi field': [40.7571, -73.8458],
  'fenway park': [42.3467, -71.0972],
  'wrigley field': [41.9484, -87.6553],
  'dodger stadium': [34.0739, -118.2400],
  'oracle park': [37.7786, -122.3893],
  'petco park': [32.7076, -117.1570],
  't-mobile park': [47.5914, -122.3325],
  'progressive field': [41.4962, -81.6852],
  'comerica park': [42.3390, -83.0485],
  'citizens bank park': [39.9061, -75.1665],
  'nationals park': [38.8730, -77.0074],
  'camden yards': [39.2838, -76.6216],
  'great american ball park': [39.0975, -84.5084],
  'pnc park': [40.4469, -80.0057],
  'busch stadium': [38.6226, -90.1928],
  'kauffman stadium': [39.0517, -94.4803],
  'minute maid park': [29.7573, -95.3555],
  'globe life field': [32.7473, -97.0845],
  'target field': [44.9818, -93.2775],
  'coors field': [39.7559, -104.9942],
  'angel stadium': [33.8003, -117.8827],
  'oakland coliseum': [37.7516, -122.2005],
  'tropicana field': [27.7682, -82.6534],
  'guaranteed rate field': [41.8299, -87.6338],
  'american family field': [43.0280, -87.9712],

  // NFL outdoor stadiums
  'arrowhead stadium': [39.0489, -94.4839],
  'lambeau field': [44.5013, -88.0622],
  'soldier field': [41.8623, -87.6167],
  'metlife stadium': [40.8128, -74.0742],
  'lincoln financial field': [39.9008, -75.1675],
  'fedexfield': [38.9076, -76.8645],
  'm&t bank stadium': [39.2780, -76.6227],
  'highmark stadium': [42.7738, -78.7870],
  'nissan stadium': [36.1664, -86.7713],
  'tiaa bank field': [30.3239, -81.6373],
  'raymond james stadium': [27.9759, -82.5033],
  'hard rock stadium': [25.9580, -80.2389],
  'paycor stadium': [39.0955, -84.5160],
  'firstenergy stadium': [41.5061, -81.6995],
  'heinz field': [40.4468, -80.0158],
  'empower field': [39.7439, -105.0201],
  'levi\'s stadium': [37.4033, -121.9694],
  'sofi stadium': [33.9534, -118.3391],
  'lumen field': [47.5952, -122.3316],
};

function lookupCoords(venueName: string): [number, number] | null {
  const key = venueName.toLowerCase().trim();
  if (VENUE_COORDS[key]) return VENUE_COORDS[key];

  // Fuzzy match — check if any known name is contained in the query
  for (const [name, coords] of Object.entries(VENUE_COORDS)) {
    if (key.includes(name) || name.includes(key)) return coords;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const WEATHER_API = 'https://api.weather.gov';
const USER_AGENT = 'Apron-IRROPS-Desk/1.0 (apron.show)';

export class WeatherClient {
  private gridCache = new Map<string, { office: string; gridX: number; gridY: number }>();

  /**
   * Get current weather conditions for a venue.
   * Returns null for indoor venues or venues we can't geolocate.
   */
  async getConditions(
    venueName: string,
    venueCity: string,
    venueState: string,
    indoor: boolean
  ): Promise<WeatherConditions | null> {
    if (indoor) return null;

    const coords = lookupCoords(venueName)
      ?? lookupCoords(`${venueCity} ${venueState}`);

    if (!coords) {
      console.warn(`[weather] No coordinates for venue: ${venueName}`);
      return null;
    }

    const [lat, lon] = coords;

    try {
      // Step 1: get the gridpoint
      const grid = await this.getGridpoint(lat, lon);
      if (!grid) return null;

      // Step 2: get the hourly forecast
      const res = await fetch(
        `${WEATHER_API}/gridpoints/${grid.office}/${grid.gridX},${grid.gridY}/forecast/hourly`,
        { headers: { 'User-Agent': USER_AGENT, Accept: 'application/geo+json' } }
      );

      if (!res.ok) {
        console.warn(`[weather] Forecast fetch failed: ${res.status}`);
        return null;
      }

      const data = await res.json() as WeatherForecastResponse;
      const period = data.properties?.periods?.[0]; // Current hour
      if (!period) return null;

      return parseConditions(period);
    } catch (err) {
      console.warn(`[weather] Fetch error:`, err);
      return null;
    }
  }

  private async getGridpoint(lat: number, lon: number) {
    const key = `${lat},${lon}`;
    const cached = this.gridCache.get(key);
    if (cached) return cached;

    const res = await fetch(`${WEATHER_API}/points/${lat},${lon}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/geo+json' },
    });

    if (!res.ok) return null;

    const data = await res.json() as WeatherPointsResponse;
    const props = data.properties;
    if (!props) return null;

    const result = {
      office: props.gridId ?? '',
      gridX: props.gridX ?? 0,
      gridY: props.gridY ?? 0,
    };

    this.gridCache.set(key, result);
    return result;
  }
}

// ---------------------------------------------------------------------------
// Internal types and helpers
// ---------------------------------------------------------------------------

interface WeatherPointsResponse {
  properties?: {
    gridId?: string;
    gridX?: number;
    gridY?: number;
  };
}

interface WeatherForecastResponse {
  properties?: {
    periods?: WeatherPeriod[];
  };
}

interface WeatherPeriod {
  startTime?: string;
  temperature?: number;
  temperatureUnit?: string;
  windSpeed?: string;
  windDirection?: string;
  shortForecast?: string;
  probabilityOfPrecipitation?: { value?: number | null };
  relativeHumidity?: { value?: number | null };
}

function parseConditions(period: WeatherPeriod): WeatherConditions {
  const tempF = period.temperature ?? 70;
  const windStr = period.windSpeed ?? '0 mph';
  const windMph = parseInt(windStr.replace(/[^\d]/g, ''), 10) || 0;
  const windDir = period.windDirection ?? '';
  const forecast = period.shortForecast ?? 'Unknown';
  const precipChance = period.probabilityOfPrecipitation?.value ?? 0;

  // Simple feels-like approximation (wind chill below 50°F, heat index above 80°F)
  let feelsLike = tempF;
  if (tempF <= 50 && windMph > 3) {
    feelsLike = Math.round(
      35.74 + 0.6215 * tempF - 35.75 * Math.pow(windMph, 0.16) + 0.4275 * tempF * Math.pow(windMph, 0.16)
    );
  } else if (tempF >= 80) {
    const rh = 50; // default relative humidity
    feelsLike = Math.round(
      -42.379 + 2.04901523 * tempF + 10.14333127 * rh
      - 0.22475541 * tempF * rh - 0.00683783 * tempF * tempF
      - 0.05481717 * rh * rh + 0.00122874 * tempF * tempF * rh
      + 0.00085282 * tempF * rh * rh - 0.00000199 * tempF * tempF * rh * rh
    );
  }

  const { risk, detail } = assessDelayRisk(forecast, precipChance, windMph, tempF);

  return {
    temperatureF: tempF,
    feelsLikeF: feelsLike,
    windSpeedMph: windMph,
    windDirection: windDir,
    shortForecast: forecast,
    precipChance,
    delayRisk: risk,
    delayDetail: detail,
    forecastTime: period.startTime ?? '',
  };
}

function assessDelayRisk(
  forecast: string,
  precipChance: number,
  windMph: number,
  tempF: number
): { risk: DelayRisk; detail: string } {
  const lower = forecast.toLowerCase();

  // Lightning / thunderstorm → high risk
  if (lower.includes('thunder') || lower.includes('lightning')) {
    return { risk: 'high', detail: `Thunderstorms in forecast (${precipChance}% precip)` };
  }

  // Heavy rain → high risk
  if (lower.includes('heavy rain') || (lower.includes('rain') && precipChance >= 80)) {
    return { risk: 'high', detail: `Heavy rain expected (${precipChance}% precip)` };
  }

  // Moderate rain → moderate risk
  if (lower.includes('rain') || lower.includes('showers')) {
    return {
      risk: precipChance >= 50 ? 'moderate' : 'low',
      detail: `Rain possible (${precipChance}% precip): ${forecast}`,
    };
  }

  // Extreme wind → moderate/high
  if (windMph >= 40) {
    return { risk: 'high', detail: `Dangerous winds: ${windMph} mph` };
  }
  if (windMph >= 25) {
    return { risk: 'moderate', detail: `High winds: ${windMph} mph` };
  }

  // Extreme heat → low-moderate (games usually continue but may have delays)
  if (tempF >= 105) {
    return { risk: 'moderate', detail: `Extreme heat: ${tempF}°F` };
  }
  if (tempF >= 95) {
    return { risk: 'low', detail: `High heat: ${tempF}°F` };
  }

  // Extreme cold (outdoor winter sports)
  if (tempF <= 0) {
    return { risk: 'moderate', detail: `Extreme cold: ${tempF}°F` };
  }

  // Snow/ice
  if (lower.includes('snow') || lower.includes('ice') || lower.includes('freezing')) {
    return { risk: 'moderate', detail: `Winter weather: ${forecast}` };
  }

  return { risk: 'none', detail: 'No delay-causing conditions detected' };
}
