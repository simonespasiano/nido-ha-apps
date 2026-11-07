/**
 * Un Raspberry Pi 5 finto per la demo: crea un /sys e un /proc in una cartella e li aggiorna ogni secondo.
 * La temperatura sale con il carico e scende con la ventola; se il governatore del kernel non è stato
 * tolto, la ventola segue i gradini del firmware come sul Pi vero.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STEPS: [number, number][] = [[75, 250], [67.5, 175], [60, 125], [50, 75]];

export class SimPi {
  private temp = 52;
  private ssd = 41;
  private t = 0;
  private cpuTicks = { idle: 0, total: 0 };
  constructor(public root: string) {
    const w = (p: string, v: string) => { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), v); };
    w('sys/class/thermal/thermal_zone0/type', 'cpu-thermal');
    w('sys/class/thermal/thermal_zone0/temp', '52000');
    w('sys/class/thermal/thermal_zone0/policy', 'step_wise');
    w('sys/class/thermal/thermal_zone0/available_policies', 'step_wise user_space');
    w('sys/class/thermal/thermal_zone0/mode', 'enabled');
    w('sys/class/thermal/cooling_device0/type', 'pwm-fan');
    w('sys/class/thermal/cooling_device0/cur_state', '1');
    w('sys/class/thermal/cooling_device0/max_state', '4');
    w('sys/class/hwmon/hwmon0/name', 'cpu_thermal');
    w('sys/class/hwmon/hwmon0/temp1_input', '52000');
    w('sys/class/hwmon/hwmon1/name', 'rp1_adc');
    w('sys/class/hwmon/hwmon1/temp1_input', '47000');
    w('sys/class/hwmon/hwmon2/name', 'pwmfan');
    w('sys/class/hwmon/hwmon2/pwm1', '75');
    w('sys/class/hwmon/hwmon2/fan1_input', '2400');
    w('sys/class/hwmon/hwmon3/name', 'nvme');
    w('sys/class/hwmon/hwmon3/temp1_input', '41000');
    w('sys/class/hwmon/hwmon4/name', 'rpi_volt');
    w('sys/class/hwmon/hwmon4/in0_lcrit_alarm', '0');
    w('sys/class/nvme/nvme0/model', 'Samsung SSD 980 500GB');
    w('sys/devices/platform/soc/soc:firmware/get_throttled', '0x0');
    for (let i = 0; i < 4; i++) w(`sys/devices/system/cpu/cpu${i}/online`, '1');
    w('sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq', '1500000');
    w('sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq', '2400000');
    w('proc/device-tree/model', 'Raspberry Pi 5 Model B Rev 1.0\0');
    w('proc/meminfo', 'MemTotal:        8245000 kB\nMemFree:         3000000 kB\nMemAvailable:    5600000 kB\n');
    w('proc/uptime', '345600.12 1000000.00');
    w('proc/loadavg', '0.42 0.55 0.61 1/300 1234');
    w('proc/stat', 'cpu  100 0 100 1000 0 0 0 0 0 0\n');
    setInterval(() => this.step(), 1000);
  }

  private r(p: string) { try { return readFileSync(join(this.root, p), 'utf8').trim(); } catch { return ''; } }
  private w(p: string, v: string | number) { writeFileSync(join(this.root, p), String(v)); }

  private step() {
    this.t++;
    // carico: base + picchi ogni tanto (es. aggiornamenti, registrazioni della camera)
    const load = 0.18 + 0.12 * Math.sin(this.t / 90) + (Math.floor(this.t / 240) % 4 === 0 ? 0.45 : 0);
    const kernelGov = this.r('sys/class/thermal/thermal_zone0/policy') === 'step_wise' && this.r('sys/class/thermal/thermal_zone0/mode') === 'enabled';
    let pwm = Number(this.r('sys/class/hwmon/hwmon2/pwm1')) || 0;
    if (kernelGov) {
      const step = STEPS.findIndex(([th]) => this.temp >= th);
      pwm = step < 0 ? 0 : STEPS[step][1];
      this.w('sys/class/hwmon/hwmon2/pwm1', pwm);
      this.w('sys/class/thermal/cooling_device0/cur_state', step < 0 ? 0 : 4 - step);
    }
    const ambient = 26;
    const heat = 10 + load * 55;              // °C sopra l'ambiente senza ventola
    const cool = 1 + (pwm / 255) * 2.6;       // la ventola divide il salto termico
    const target = ambient + heat / cool;
    this.temp += (target - this.temp) * 0.04 + (Math.random() - 0.5) * 0.3;
    this.ssd += ((this.temp - 10) - this.ssd) * 0.01;
    this.w('sys/class/thermal/thermal_zone0/temp', Math.round(this.temp * 1000));
    this.w('sys/class/hwmon/hwmon0/temp1_input', Math.round(this.temp * 1000));
    this.w('sys/class/hwmon/hwmon1/temp1_input', Math.round((this.temp - 5) * 1000));
    this.w('sys/class/hwmon/hwmon3/temp1_input', Math.round(this.ssd * 1000));
    this.w('sys/class/hwmon/hwmon2/fan1_input', pwm ? Math.round(1500 + (pwm / 255) * 6500 + Math.random() * 60) : 0);
    this.w('sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq', load > 0.5 ? 2400000 : 1500000);
    this.cpuTicks.total += 400; this.cpuTicks.idle += Math.round(400 * (1 - load));
    this.w('proc/stat', `cpu  ${this.cpuTicks.total - this.cpuTicks.idle} 0 0 ${this.cpuTicks.idle} 0 0 0 0 0 0\n`);
    this.w('proc/loadavg', `${(load * 4).toFixed(2)} ${(load * 3.6).toFixed(2)} 0.61 1/300 1234`);
    this.w('proc/uptime', `${345600 + this.t}.00 1000000.00`);
  }
}
