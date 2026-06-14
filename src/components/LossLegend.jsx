// Compact colour legend explaining the loss → colour ramp.

import { lossCss } from '../lib/loss-color.js'

const TICKS = [0, 5, 15, 35, 70, 100]

export default function LossLegend() {
  const gradient = `linear-gradient(to right, ${TICKS.map(
    (t) => `${lossCss(t)} ${t}%`,
  ).join(', ')})`
  return (
    <div className="loss-legend">
      <span className="ll-title">Packet loss</span>
      <div className="ll-bar" style={{ background: gradient }} />
      <div className="ll-ticks">
        <span>0%</span>
        <span>15%</span>
        <span>35%</span>
        <span>100%</span>
      </div>
    </div>
  )
}
