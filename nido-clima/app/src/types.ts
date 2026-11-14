import type { Action, RoomControls } from './controls.js';

export interface Room {
  id: string;            // slug stabile, es. "camera"
  name: string;          // nome leggibile, es. "Camera"
  valve: string;         // climate.* della valvola reale (misura vicino al termosifone)
  thermostat?: string;   // climate.* del termostato virtuale (Versatile/Better Thermostat), se esiste
  tempSensor: string;    // sensor.* temperatura ambiente
  humSensor?: string;    // sensor.* umidità
  valveSensorMode?: string; // select.* che indica se la valvola usa il sensore interno o esterno
  valveTempSensor?: string; // sensore indicato a mano per la temperatura del termosifone
  valveTempSource?: 'valvola' | 'manuale'; // da dove arriva, aggiornato a ogni lettura
  valveExternal?: boolean; // la valvola usa come sensore il sensore della stanza
  valveExtInput?: string;  // number.* in cui scrivere la temperatura della stanza (sensore esterno)
  source: 'auto' | 'manuale' | 'demo';
}

export interface Sample {
  ts: number;               // epoch ms
  tRoom: number | null;     // temperatura ambiente
  hRoom: number | null;     // umidità
  tValve: number | null;    // temperatura del termosifone usata per il rilevamento
  tValveLocal?: number | null;    // temperatura riportata dalla valvola (local_temperature)
  setpoint: number | null;  // temperatura desiderata
  mode: string | null;      // heat / off / ...
  heating?: boolean;        // esito del rilevamento
}

export interface RoomStatus {
  heating: boolean;
  since: number;             // da quando è in questo stato
  delta: number | null;      // valvola − stanza
  slopeValve: number | null; // °C/ora
  slopeRoom: number | null;  // °C/ora
  confidence: 'alta' | 'media' | 'bassa';
  reason: string;            // spiegazione leggibile
  window: boolean;           // sospetta finestra aperta
  requesting: boolean;       // la stanza vorrebbe calore
  supplyHot?: boolean;       // valvola calda ma stanza già in temperatura: valvola chiusa, non conta come acceso
  requestingSince: number | null;
  /** 'temperatura' = dal termosifone (valvola su internal o sonda); 'richiesta' = solo richiesta di calore (sensore esterno) */
  basis?: 'temperatura' | 'richiesta';
}

export type EventKind =
  | 'calorifero_on' | 'calorifero_off'
  | 'finestra' | 'impianto_on' | 'impianto_off'
  | 'obiettivo' | 'modalita' | 'comando' | 'sistema' | 'automazione' | 'umidita';

export interface AppEvent {
  id?: number;
  ts: number;
  room: string | null;
  kind: EventKind;
  message: string;
}

export interface DataSource {
  start(): Promise<void>;
  rooms(): Room[];
  read(room: Room, at?: number): Sample;
  publish?(room: Room, status: RoomStatus, plant: PlantStatus): Promise<void>;
  publishPlant?(plant: PlantStatus): Promise<void>;
  listEntities?(): EntityInfo[];
  diagnosis?: Diagnosis;
  /** Posizione della casa (da Home Assistant). */
  location?(): { lat: number; lon: number; name: string } | null;
  /** Temperatura e umidità di un eventuale sensore esterno. */
  outdoorSensor?(): { temp: number | null; hum: number | null } | null;
  controls?(room: Room): RoomControls;
  /** Esegue un comando e restituisce la descrizione per il diario. */
  act?(room: Room, action: Action): Promise<string>;
  /** Chiamata di servizio diretta (usata dalle automazioni e dall'invio del sensore esterno). */
  service?(domain: string, service: string, entityId: string | null, data: Record<string, unknown>): Promise<void>;
  /** Stato del collegamento valvola ↔ sensore della stanza. */
  valveLink?(room: Room): ValveLink;
  people?(): { id: string; name: string; home: boolean; state: string; trackers: number }[];
  notifyServices?(): Promise<string[]>;
}

export interface ValveLink {
  select: string | null;      // select.*_sensor
  input: string | null;       // number.*_external_temperature_input
  mode: string | null;        // internal / external
  inputValue: number | null;  // ultimo valore ricevuto dalla valvola
  local: number | null;       // temperatura che la valvola sta usando
}

export interface PlantStatus {
  state: 'acceso' | 'spento' | 'a_riposo';
  since: number;
  label: string;
}

export interface EntityInfo {
  entity_id: string;
  name: string;
  domain: string;
  area: string | null;
  state: string;
  unit?: string;
  role: string; // descrizione in chiaro: "Valvola termostatica", "Sensore temperatura"...
}

export interface AreaDiagnosis {
  area: string;
  valve: string | null;
  thermostat: string | null;
  temp: string | null;
  hum: string | null;
  entities: number;
  missing: string[];
}

export interface Diagnosis {
  areas: AreaDiagnosis[];
  unassigned: string[];
  mode: 'auto' | 'manuale';
}
