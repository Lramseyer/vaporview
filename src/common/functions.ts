export function bitRangeString(msb: number, lsb: number): string {
  if (msb < 0 || lsb < 0) {return "";}
  if (msb === lsb) {return "[" + msb + "]";}
  return "[" + msb + ":" + lsb + "]";
}

export function toStringWithCommas(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function scaleFromUnits(unit: string | undefined) {
  switch (unit) {
    case 'zs': return 1e-21;
    case 'as': return 1e-18;
    case 'fs': return 1e-15;
    case 'ps': return 1e-12;
    case 'ns': return 1e-9;
    case 'us': return 1e-6;
    case 'µs': return 1e-6;
    case 'ms': return 1e-3;
    case 's':  return 1;
    case 'ks': return 1000;
    default: return 1;
  }
}

export function logScaleFromUnits(unit: string | undefined) {
  switch (unit) {
    case 'zs': return -21;
    case 'as': return -18;
    case 'fs': return -15;
    case 'ps': return -12;
    case 'ns': return -9;
    case 'us': return -6;
    case 'µs': return -6;
    case 'ms': return -3;
    case 's':  return 0;
    case 'ks': return 3;
    default: return 0;
  }
}