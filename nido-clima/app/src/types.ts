export interface Room {
  id: string;            // slug stabile, es. "camera"
  name: string;          // nome leggibile, es. "Camera"
  valve: string;         // climate.* della valvola reale (misura vicino al termosifone)
  thermostat?: string;   // climate.* del termostato virtuale (Versatile/Better Thermostat), se esiste
  tempSensor: string;    // sensor.* temperatura ambiente
  humSensor?: string;    // sensor.* umidità
  source: 'auto' | 'manuale' | 'demo';
}

export interface Sample {
  ts: number;               // epoch ms
  tRoom: number | null;     // temperatura ambiente
  hRoom: number | null;     // umidità
  tValve: number | null;    // temperatura misurata dalla valvola
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
  requestingSince: number | null;
}

export type EventKind =
  | 'calorifero_on' | 'calorifero_off'
  | 'finestra' | 'impianto_on' | 'impianto_off'
  | 'obiettivo' | 'modalita' | 'sistema';

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
