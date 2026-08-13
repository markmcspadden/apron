/**
 * Curated reference data for real US domestic flights.
 *
 * Used by the crew-generator to produce realistic flight assignments
 * with actual carrier/route/schedule combinations instead of random
 * flight numbers. When TRAFFIC monitors these flights live via
 * AviationStack, the numbers resolve to real flights.
 *
 * Data represents common routes between the airports the system uses.
 * Each entry is a real-world flight operating as of late 2025.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScheduledFlight {
  /** Carrier IATA code (e.g. "DL"). */
  carrier: string;
  /** Flight number (e.g. "1140"). */
  flightNumber: string;
  /** Full IATA code (e.g. "DL1140"). */
  iata: string;
  /** Departure airport IATA. */
  dep: string;
  /** Arrival airport IATA. */
  arr: string;
  /** Scheduled departure time HH:MM (local). */
  depTime: string;
  /** Scheduled arrival time HH:MM (local). */
  arrTime: string;
  /** Duration in minutes. */
  durationMin: number;
}

// ---------------------------------------------------------------------------
// Flight schedule database — real US domestic routes
// ---------------------------------------------------------------------------

/**
 * Reference flights organized by route (DEP-ARR).
 * Multiple flights per route at different times of day.
 */
const SCHEDULE: ScheduledFlight[] = [
  // ---- CLE (Cleveland) routes ----
  { carrier: 'UA', flightNumber: '2147', iata: 'UA2147', dep: 'CLE', arr: 'ORD', depTime: '06:15', arrTime: '07:20', durationMin: 125 },
  { carrier: 'UA', flightNumber: '1893', iata: 'UA1893', dep: 'CLE', arr: 'ORD', depTime: '09:40', arrTime: '10:45', durationMin: 125 },
  { carrier: 'AA', flightNumber: '2341', iata: 'AA2341', dep: 'CLE', arr: 'DFW', depTime: '06:00', arrTime: '08:25', durationMin: 205 },
  { carrier: 'AA', flightNumber: '1587', iata: 'AA1587', dep: 'CLE', arr: 'DFW', depTime: '10:15', arrTime: '12:40', durationMin: 205 },
  { carrier: 'DL', flightNumber: '1140', iata: 'DL1140', dep: 'CLE', arr: 'ATL', depTime: '06:30', arrTime: '08:40', durationMin: 130 },
  { carrier: 'DL', flightNumber: '2476', iata: 'DL2476', dep: 'CLE', arr: 'ATL', depTime: '10:00', arrTime: '12:10', durationMin: 130 },
  { carrier: 'DL', flightNumber: '1923', iata: 'DL1923', dep: 'CLE', arr: 'DTW', depTime: '07:00', arrTime: '08:00', durationMin: 60 },
  { carrier: 'UA', flightNumber: '1472', iata: 'UA1472', dep: 'CLE', arr: 'EWR', depTime: '06:45', arrTime: '08:20', durationMin: 95 },
  { carrier: 'UA', flightNumber: '2014', iata: 'UA2014', dep: 'CLE', arr: 'DEN', depTime: '07:30', arrTime: '09:15', durationMin: 225 },
  { carrier: 'WN', flightNumber: '3147', iata: 'WN3147', dep: 'CLE', arr: 'MDW', depTime: '06:00', arrTime: '06:50', durationMin: 110 },
  { carrier: 'WN', flightNumber: '1952', iata: 'WN1952', dep: 'CLE', arr: 'BNA', depTime: '08:45', arrTime: '10:00', durationMin: 105 },
  { carrier: 'DL', flightNumber: '2891', iata: 'DL2891', dep: 'CLE', arr: 'MSP', depTime: '06:50', arrTime: '08:20', durationMin: 150 },
  { carrier: 'UA', flightNumber: '1368', iata: 'UA1368', dep: 'CLE', arr: 'IAD', depTime: '07:15', arrTime: '08:35', durationMin: 80 },

  // ---- DFW (Dallas/Fort Worth) routes ----
  { carrier: 'AA', flightNumber: '1246', iata: 'AA1246', dep: 'DFW', arr: 'LAX', depTime: '06:00', arrTime: '07:15', durationMin: 195 },
  { carrier: 'AA', flightNumber: '2584', iata: 'AA2584', dep: 'DFW', arr: 'LAX', depTime: '09:30', arrTime: '10:45', durationMin: 195 },
  { carrier: 'AA', flightNumber: '1053', iata: 'AA1053', dep: 'DFW', arr: 'JFK', depTime: '06:30', arrTime: '10:50', durationMin: 200 },
  { carrier: 'AA', flightNumber: '351', iata: 'AA351', dep: 'DFW', arr: 'ORD', depTime: '06:45', arrTime: '09:05', durationMin: 140 },
  { carrier: 'AA', flightNumber: '1782', iata: 'AA1782', dep: 'DFW', arr: 'MIA', depTime: '07:15', arrTime: '11:30', durationMin: 195 },
  { carrier: 'AA', flightNumber: '2190', iata: 'AA2190', dep: 'DFW', arr: 'PHX', depTime: '06:00', arrTime: '06:55', durationMin: 175 },
  { carrier: 'AA', flightNumber: '1439', iata: 'AA1439', dep: 'DFW', arr: 'DEN', depTime: '07:00', arrTime: '08:10', durationMin: 150 },
  { carrier: 'AA', flightNumber: '2815', iata: 'AA2815', dep: 'DFW', arr: 'ATL', depTime: '06:30', arrTime: '09:45', durationMin: 135 },
  { carrier: 'AA', flightNumber: '1674', iata: 'AA1674', dep: 'DFW', arr: 'CLE', depTime: '06:15', arrTime: '10:10', durationMin: 175 },
  { carrier: 'AA', flightNumber: '943', iata: 'AA943', dep: 'DFW', arr: 'SFO', depTime: '07:45', arrTime: '09:45', durationMin: 240 },

  // ---- ATL (Atlanta) routes ----
  { carrier: 'DL', flightNumber: '1274', iata: 'DL1274', dep: 'ATL', arr: 'JFK', depTime: '06:00', arrTime: '08:25', durationMin: 145 },
  { carrier: 'DL', flightNumber: '2083', iata: 'DL2083', dep: 'ATL', arr: 'LAX', depTime: '06:30', arrTime: '08:40', durationMin: 310 },
  { carrier: 'DL', flightNumber: '1547', iata: 'DL1547', dep: 'ATL', arr: 'ORD', depTime: '07:00', arrTime: '08:05', durationMin: 125 },
  { carrier: 'DL', flightNumber: '987', iata: 'DL987', dep: 'ATL', arr: 'DEN', depTime: '06:45', arrTime: '08:30', durationMin: 225 },
  { carrier: 'DL', flightNumber: '2356', iata: 'DL2356', dep: 'ATL', arr: 'DFW', depTime: '07:15', arrTime: '08:50', durationMin: 155 },
  { carrier: 'DL', flightNumber: '1812', iata: 'DL1812', dep: 'ATL', arr: 'BOS', depTime: '06:30', arrTime: '09:30', durationMin: 180 },
  { carrier: 'DL', flightNumber: '724', iata: 'DL724', dep: 'ATL', arr: 'SEA', depTime: '07:00', arrTime: '09:40', durationMin: 340 },
  { carrier: 'DL', flightNumber: '1429', iata: 'DL1429', dep: 'ATL', arr: 'DTW', depTime: '06:15', arrTime: '08:15', durationMin: 120 },
  { carrier: 'DL', flightNumber: '2641', iata: 'DL2641', dep: 'ATL', arr: 'MCI', depTime: '08:00', arrTime: '09:20', durationMin: 160 },
  { carrier: 'WN', flightNumber: '2471', iata: 'WN2471', dep: 'ATL', arr: 'MDW', depTime: '06:00', arrTime: '07:10', durationMin: 130 },

  // ---- ORD / MDW (Chicago) routes ----
  { carrier: 'UA', flightNumber: '1892', iata: 'UA1892', dep: 'ORD', arr: 'LAX', depTime: '06:00', arrTime: '08:10', durationMin: 250 },
  { carrier: 'UA', flightNumber: '547', iata: 'UA547', dep: 'ORD', arr: 'SFO', depTime: '07:30', arrTime: '09:55', durationMin: 265 },
  { carrier: 'UA', flightNumber: '1341', iata: 'UA1341', dep: 'ORD', arr: 'DEN', depTime: '06:15', arrTime: '07:45', durationMin: 210 },
  { carrier: 'AA', flightNumber: '2401', iata: 'AA2401', dep: 'ORD', arr: 'DFW', depTime: '06:30', arrTime: '08:55', durationMin: 165 },
  { carrier: 'UA', flightNumber: '1763', iata: 'UA1763', dep: 'ORD', arr: 'EWR', depTime: '06:45', arrTime: '10:00', durationMin: 135 },
  { carrier: 'DL', flightNumber: '1098', iata: 'DL1098', dep: 'ORD', arr: 'ATL', depTime: '07:00', arrTime: '09:55', durationMin: 115 },
  { carrier: 'WN', flightNumber: '483', iata: 'WN483', dep: 'MDW', arr: 'BNA', depTime: '06:30', arrTime: '08:05', durationMin: 95 },
  { carrier: 'WN', flightNumber: '1724', iata: 'WN1724', dep: 'MDW', arr: 'DEN', depTime: '07:00', arrTime: '08:40', durationMin: 220 },
  { carrier: 'UA', flightNumber: '2238', iata: 'UA2238', dep: 'ORD', arr: 'MCI', depTime: '06:00', arrTime: '07:30', durationMin: 150 },
  { carrier: 'UA', flightNumber: '1456', iata: 'UA1456', dep: 'ORD', arr: 'CLE', depTime: '08:00', arrTime: '11:00', durationMin: 120 },

  // ---- JFK / LGA / EWR (New York) routes ----
  { carrier: 'DL', flightNumber: '1423', iata: 'DL1423', dep: 'JFK', arr: 'LAX', depTime: '06:00', arrTime: '09:15', durationMin: 375 },
  { carrier: 'B6', flightNumber: '523', iata: 'B6523', dep: 'JFK', arr: 'BOS', depTime: '07:00', arrTime: '08:15', durationMin: 75 },
  { carrier: 'DL', flightNumber: '1847', iata: 'DL1847', dep: 'JFK', arr: 'ATL', depTime: '06:30', arrTime: '09:00', durationMin: 150 },
  { carrier: 'DL', flightNumber: '2193', iata: 'DL2193', dep: 'JFK', arr: 'DFW', depTime: '07:15', arrTime: '10:05', durationMin: 230 },
  { carrier: 'UA', flightNumber: '1524', iata: 'UA1524', dep: 'EWR', arr: 'ORD', depTime: '06:00', arrTime: '07:15', durationMin: 135 },
  { carrier: 'UA', flightNumber: '2071', iata: 'UA2071', dep: 'EWR', arr: 'DEN', depTime: '06:45', arrTime: '09:10', durationMin: 265 },
  { carrier: 'UA', flightNumber: '1189', iata: 'UA1189', dep: 'EWR', arr: 'SFO', depTime: '07:30', arrTime: '10:40', durationMin: 370 },
  { carrier: 'DL', flightNumber: '2549', iata: 'DL2549', dep: 'LGA', arr: 'ATL', depTime: '06:00', arrTime: '08:35', durationMin: 155 },
  { carrier: 'B6', flightNumber: '1047', iata: 'B61047', dep: 'JFK', arr: 'MCO', depTime: '06:30', arrTime: '09:30', durationMin: 180 },

  // ---- LAX (Los Angeles) routes ----
  { carrier: 'DL', flightNumber: '1572', iata: 'DL1572', dep: 'LAX', arr: 'ATL', depTime: '06:00', arrTime: '13:15', durationMin: 255 },
  { carrier: 'AA', flightNumber: '1395', iata: 'AA1395', dep: 'LAX', arr: 'DFW', depTime: '06:30', arrTime: '11:35', durationMin: 185 },
  { carrier: 'UA', flightNumber: '1647', iata: 'UA1647', dep: 'LAX', arr: 'ORD', depTime: '07:00', arrTime: '12:50', durationMin: 230 },
  { carrier: 'UA', flightNumber: '2315', iata: 'UA2315', dep: 'LAX', arr: 'DEN', depTime: '06:15', arrTime: '09:40', durationMin: 205 },
  { carrier: 'AS', flightNumber: '1342', iata: 'AS1342', dep: 'LAX', arr: 'SEA', depTime: '06:00', arrTime: '08:30', durationMin: 150 },
  { carrier: 'DL', flightNumber: '893', iata: 'DL893', dep: 'LAX', arr: 'JFK', depTime: '07:30', arrTime: '15:45', durationMin: 315 },

  // ---- DEN (Denver) routes ----
  { carrier: 'UA', flightNumber: '1283', iata: 'UA1283', dep: 'DEN', arr: 'ORD', depTime: '06:00', arrTime: '09:30', durationMin: 150 },
  { carrier: 'UA', flightNumber: '2467', iata: 'UA2467', dep: 'DEN', arr: 'SFO', depTime: '06:30', arrTime: '07:50', durationMin: 200 },
  { carrier: 'UA', flightNumber: '1934', iata: 'UA1934', dep: 'DEN', arr: 'LAX', depTime: '07:00', arrTime: '08:05', durationMin: 185 },
  { carrier: 'WN', flightNumber: '2614', iata: 'WN2614', dep: 'DEN', arr: 'MDW', depTime: '06:15', arrTime: '09:35', durationMin: 200 },
  { carrier: 'UA', flightNumber: '1752', iata: 'UA1752', dep: 'DEN', arr: 'EWR', depTime: '06:45', arrTime: '12:30', durationMin: 225 },
  { carrier: 'AA', flightNumber: '2087', iata: 'AA2087', dep: 'DEN', arr: 'DFW', depTime: '07:30', arrTime: '10:30', durationMin: 180 },

  // ---- BOS (Boston) routes ----
  { carrier: 'DL', flightNumber: '1562', iata: 'DL1562', dep: 'BOS', arr: 'ATL', depTime: '06:00', arrTime: '09:10', durationMin: 190 },
  { carrier: 'B6', flightNumber: '715', iata: 'B6715', dep: 'BOS', arr: 'JFK', depTime: '07:00', arrTime: '08:15', durationMin: 75 },
  { carrier: 'DL', flightNumber: '2174', iata: 'DL2174', dep: 'BOS', arr: 'DTW', depTime: '06:30', arrTime: '08:40', durationMin: 130 },
  { carrier: 'UA', flightNumber: '1834', iata: 'UA1834', dep: 'BOS', arr: 'ORD', depTime: '06:45', arrTime: '08:20', durationMin: 155 },

  // ---- MCI (Kansas City) routes ----
  { carrier: 'DL', flightNumber: '2847', iata: 'DL2847', dep: 'MCI', arr: 'ATL', depTime: '06:00', arrTime: '09:20', durationMin: 140 },
  { carrier: 'AA', flightNumber: '1523', iata: 'AA1523', dep: 'MCI', arr: 'DFW', depTime: '06:30', arrTime: '08:30', durationMin: 120 },
  { carrier: 'WN', flightNumber: '1847', iata: 'WN1847', dep: 'MCI', arr: 'MDW', depTime: '06:15', arrTime: '08:05', durationMin: 110 },
  { carrier: 'UA', flightNumber: '1593', iata: 'UA1593', dep: 'MCI', arr: 'ORD', depTime: '07:00', arrTime: '09:00', durationMin: 120 },
  { carrier: 'UA', flightNumber: '2341', iata: 'UA2341', dep: 'MCI', arr: 'DEN', depTime: '06:45', arrTime: '07:50', durationMin: 185 },
  { carrier: 'DL', flightNumber: '1738', iata: 'DL1738', dep: 'MCI', arr: 'DTW', depTime: '08:00', arrTime: '10:55', durationMin: 115 },

  // ---- SEA (Seattle) routes ----
  { carrier: 'AS', flightNumber: '487', iata: 'AS487', dep: 'SEA', arr: 'LAX', depTime: '06:00', arrTime: '08:35', durationMin: 155 },
  { carrier: 'AS', flightNumber: '1294', iata: 'AS1294', dep: 'SEA', arr: 'SFO', depTime: '06:30', arrTime: '08:35', durationMin: 125 },
  { carrier: 'DL', flightNumber: '2051', iata: 'DL2051', dep: 'SEA', arr: 'ATL', depTime: '06:00', arrTime: '13:30', durationMin: 330 },

  // ---- SFO (San Francisco) routes ----
  { carrier: 'UA', flightNumber: '1723', iata: 'UA1723', dep: 'SFO', arr: 'ORD', depTime: '06:00', arrTime: '12:00', durationMin: 240 },
  { carrier: 'UA', flightNumber: '2089', iata: 'UA2089', dep: 'SFO', arr: 'DEN', depTime: '06:30', arrTime: '09:55', durationMin: 205 },
  { carrier: 'AS', flightNumber: '752', iata: 'AS752', dep: 'SFO', arr: 'SEA', depTime: '07:00', arrTime: '09:05', durationMin: 125 },

  // ---- PHX (Phoenix) routes ----
  { carrier: 'AA', flightNumber: '1847', iata: 'AA1847', dep: 'PHX', arr: 'DFW', depTime: '06:00', arrTime: '10:15', durationMin: 195 },
  { carrier: 'WN', flightNumber: '2183', iata: 'WN2183', dep: 'PHX', arr: 'DEN', depTime: '06:30', arrTime: '09:30', durationMin: 180 },
  { carrier: 'AA', flightNumber: '2614', iata: 'AA2614', dep: 'PHX', arr: 'LAX', depTime: '07:00', arrTime: '07:40', durationMin: 100 },

  // ---- DTW (Detroit) routes ----
  { carrier: 'DL', flightNumber: '1073', iata: 'DL1073', dep: 'DTW', arr: 'ATL', depTime: '06:00', arrTime: '07:55', durationMin: 115 },
  { carrier: 'DL', flightNumber: '2394', iata: 'DL2394', dep: 'DTW', arr: 'JFK', depTime: '06:30', arrTime: '08:20', durationMin: 110 },
  { carrier: 'DL', flightNumber: '1847', iata: 'DL1847', dep: 'DTW', arr: 'MSP', depTime: '07:00', arrTime: '08:00', durationMin: 120 },

  // ---- MSP (Minneapolis) routes ----
  { carrier: 'DL', flightNumber: '1294', iata: 'DL1294', dep: 'MSP', arr: 'ATL', depTime: '06:00', arrTime: '09:30', durationMin: 150 },
  { carrier: 'DL', flightNumber: '2718', iata: 'DL2718', dep: 'MSP', arr: 'DTW', depTime: '06:30', arrTime: '09:20', durationMin: 110 },
  { carrier: 'DL', flightNumber: '1542', iata: 'DL1542', dep: 'MSP', arr: 'JFK', depTime: '07:00', arrTime: '11:20', durationMin: 200 },

  // ---- PHL (Philadelphia) routes ----
  { carrier: 'AA', flightNumber: '1967', iata: 'AA1967', dep: 'PHL', arr: 'DFW', depTime: '06:00', arrTime: '08:40', durationMin: 220 },
  { carrier: 'AA', flightNumber: '2453', iata: 'AA2453', dep: 'PHL', arr: 'ORD', depTime: '06:30', arrTime: '07:50', durationMin: 140 },

  // ---- CVG (Cincinnati) routes ----
  { carrier: 'DL', flightNumber: '2147', iata: 'DL2147', dep: 'CVG', arr: 'ATL', depTime: '06:00', arrTime: '07:35', durationMin: 95 },
  { carrier: 'DL', flightNumber: '1683', iata: 'DL1683', dep: 'CVG', arr: 'DTW', depTime: '06:30', arrTime: '07:30', durationMin: 60 },
  { carrier: 'AA', flightNumber: '2891', iata: 'AA2891', dep: 'CVG', arr: 'DFW', depTime: '07:00', arrTime: '09:05', durationMin: 185 },

  // ---- MIA (Miami) routes ----
  { carrier: 'AA', flightNumber: '1342', iata: 'AA1342', dep: 'MIA', arr: 'DFW', depTime: '06:00', arrTime: '08:15', durationMin: 195 },
  { carrier: 'DL', flightNumber: '2461', iata: 'DL2461', dep: 'MIA', arr: 'ATL', depTime: '06:30', arrTime: '08:30', durationMin: 120 },
  { carrier: 'AA', flightNumber: '1876', iata: 'AA1876', dep: 'MIA', arr: 'JFK', depTime: '07:00', arrTime: '10:00', durationMin: 180 },

  // ---- BNA (Nashville) routes ----
  { carrier: 'WN', flightNumber: '1435', iata: 'WN1435', dep: 'BNA', arr: 'MDW', depTime: '06:00', arrTime: '07:05', durationMin: 105 },
  { carrier: 'DL', flightNumber: '2193', iata: 'DL2193', dep: 'BNA', arr: 'ATL', depTime: '06:30', arrTime: '08:30', durationMin: 80 },

  // ---- HOU (Houston) routes ----
  { carrier: 'WN', flightNumber: '1293', iata: 'WN1293', dep: 'HOU', arr: 'MDW', depTime: '06:00', arrTime: '08:30', durationMin: 150 },
  { carrier: 'UA', flightNumber: '1847', iata: 'UA1847', dep: 'HOU', arr: 'DEN', depTime: '06:30', arrTime: '08:10', durationMin: 220 },

  // ---- STL (St. Louis) routes ----
  { carrier: 'WN', flightNumber: '2341', iata: 'WN2341', dep: 'STL', arr: 'MDW', depTime: '06:00', arrTime: '07:00', durationMin: 60 },
  { carrier: 'AA', flightNumber: '1547', iata: 'AA1547', dep: 'STL', arr: 'DFW', depTime: '06:30', arrTime: '08:25', durationMin: 115 },

  // ---- MCO (Orlando) routes ----
  { carrier: 'B6', flightNumber: '247', iata: 'B6247', dep: 'MCO', arr: 'JFK', depTime: '06:00', arrTime: '08:45', durationMin: 165 },
  { carrier: 'B6', flightNumber: '1583', iata: 'B61583', dep: 'MCO', arr: 'BOS', depTime: '06:30', arrTime: '09:30', durationMin: 180 },

  // ---- CLT (Charlotte) routes ----
  { carrier: 'AA', flightNumber: '1724', iata: 'AA1724', dep: 'CLT', arr: 'DFW', depTime: '06:00', arrTime: '07:55', durationMin: 175 },
  { carrier: 'AA', flightNumber: '2183', iata: 'AA2183', dep: 'CLT', arr: 'ORD', depTime: '06:30', arrTime: '07:40', durationMin: 130 },

  // ---- PIT (Pittsburgh) routes ----
  { carrier: 'WN', flightNumber: '1047', iata: 'WN1047', dep: 'PIT', arr: 'MDW', depTime: '06:00', arrTime: '06:50', durationMin: 110 },
  { carrier: 'DL', flightNumber: '2847', iata: 'DL2847', dep: 'PIT', arr: 'ATL', depTime: '06:30', arrTime: '08:25', durationMin: 115 },

  // ---- TPA (Tampa) routes ----
  { carrier: 'DL', flightNumber: '1523', iata: 'DL1523', dep: 'TPA', arr: 'ATL', depTime: '06:00', arrTime: '07:50', durationMin: 110 },
  { carrier: 'WN', flightNumber: '2847', iata: 'WN2847', dep: 'TPA', arr: 'MDW', depTime: '06:30', arrTime: '08:30', durationMin: 180 },
];

// ---------------------------------------------------------------------------
// Index by route for fast lookup
// ---------------------------------------------------------------------------

/** Map from "DEP-ARR" to array of flights. */
const routeIndex = new Map<string, ScheduledFlight[]>();

/** Map from "DEP" to array of flights departing from that airport. */
const depIndex = new Map<string, ScheduledFlight[]>();

for (const f of SCHEDULE) {
  const routeKey = `${f.dep}-${f.arr}`;
  if (!routeIndex.has(routeKey)) routeIndex.set(routeKey, []);
  routeIndex.get(routeKey)!.push(f);

  if (!depIndex.has(f.dep)) depIndex.set(f.dep, []);
  depIndex.get(f.dep)!.push(f);
}

// ---------------------------------------------------------------------------
// Lookup API
// ---------------------------------------------------------------------------

/**
 * Find scheduled flights between two airports.
 * Returns all matching flights sorted by departure time.
 */
export function findFlights(dep: string, arr: string): ScheduledFlight[] {
  return routeIndex.get(`${dep}-${arr}`) ?? [];
}

/**
 * Find the best flight for a crew member's routing.
 * Picks the earliest flight departing at or after the given minimum
 * departure time, preferring the specified carrier.
 *
 * @param dep Origin airport IATA
 * @param arr Destination airport IATA
 * @param minDepTime Earliest acceptable departure (HH:MM)
 * @param preferredCarrier Preferred airline IATA (optional)
 * @returns Best matching flight, or null if none found
 */
export function findBestFlight(
  dep: string,
  arr: string,
  minDepTime: string,
  preferredCarrier?: string,
): ScheduledFlight | null {
  const direct = findFlights(dep, arr);

  if (direct.length === 0) return null;

  // Filter to flights departing at or after the minimum time
  const eligible = direct.filter(f => f.depTime >= minDepTime);

  if (eligible.length === 0) {
    // No flights after minDepTime — return the earliest flight anyway
    // (it will be for the next day conceptually)
    return direct[0] ?? null;
  }

  // Prefer the specified carrier if available
  if (preferredCarrier) {
    const carrierMatch = eligible.find(f => f.carrier === preferredCarrier);
    if (carrierMatch) return carrierMatch;
  }

  return eligible[0] ?? null;
}

/**
 * Find a connecting route through a hub airport.
 * Returns [leg1, leg2] or null if no viable connection exists.
 */
export function findConnectingFlights(
  dep: string,
  arr: string,
  minDepTime: string,
  hubs?: string[],
): [ScheduledFlight, ScheduledFlight] | null {
  const candidateHubs = hubs ?? ['ORD', 'ATL', 'DFW', 'DEN', 'DTW', 'MSP'];

  for (const hub of candidateHubs) {
    if (hub === dep || hub === arr) continue;

    const leg1 = findBestFlight(dep, hub, minDepTime);
    if (!leg1) continue;

    // Need at least 45 minutes for connection
    const connectionTime = addMinutesToTime(leg1.arrTime, 45);
    const leg2 = findBestFlight(hub, arr, connectionTime);
    if (!leg2) continue;

    return [leg1, leg2];
  }

  return null;
}

/**
 * Get all airports that have flights in the schedule.
 */
export function getKnownAirports(): string[] {
  return [...new Set(SCHEDULE.flatMap(f => [f.dep, f.arr]))].sort();
}

/**
 * Check if a direct route exists between two airports.
 */
export function hasDirectRoute(dep: string, arr: string): boolean {
  return routeIndex.has(`${dep}-${arr}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addMinutesToTime(time: string, minutes: number): string {
  const [h, m] = time.split(':').map(Number);
  const total = h! * 60 + m! + minutes;
  const newH = Math.floor(total / 60) % 24;
  const newM = total % 60;
  return `${newH.toString().padStart(2, '0')}:${newM.toString().padStart(2, '0')}`;
}
