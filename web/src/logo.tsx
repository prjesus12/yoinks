// the terminal logo, drawn in currentColor so it follows the theme
export function Logo({height = 18}: {height?: number}) {
  return (
    <svg viewBox="0 0 240 60" height={height} role="img" aria-label="yoinks" style={{display: 'block'}}>
      <defs>
<pattern id="yoinks-shade" width="5" height="5" patternUnits="userSpaceOnUse">
<rect width="2.5" height="2.5" fill="currentColor"/>
<rect x="2.5" y="2.5" width="2.5" height="2.5" fill="currentColor"/>
</pattern>
</defs>
<rect x="0" y="0" width="10" height="20" fill="url(#yoinks-shade)"/>
<rect x="20" y="0" width="10" height="20" fill="url(#yoinks-shade)"/>
<rect x="40" y="0" width="10" height="20" fill="currentColor"/>
<rect x="50" y="0" width="10" height="10" fill="currentColor"/>
<rect x="60" y="0" width="10" height="20" fill="currentColor"/>
<rect x="80" y="0" width="10" height="10" fill="currentColor"/>
<rect x="90" y="0" width="10" height="20" fill="currentColor"/>
<rect x="100" y="0" width="10" height="10" fill="currentColor"/>
<rect x="120" y="0" width="10" height="20" fill="currentColor"/>
<rect x="130" y="0" width="10" height="10" fill="currentColor"/>
<rect x="140" y="10" width="10" height="10" fill="currentColor"/>
<rect x="150" y="0" width="10" height="20" fill="currentColor"/>
<rect x="170" y="0" width="10" height="20" fill="currentColor"/>
<rect x="190" y="0" width="10" height="20" fill="currentColor"/>
<rect x="210" y="0" width="10" height="20" fill="currentColor"/>
<rect x="220" y="0" width="10" height="10" fill="currentColor"/>
<rect x="230" y="0" width="10" height="10" fill="currentColor"/>
<rect x="0" y="20" width="10" height="10" fill="currentColor"/>
<rect x="10" y="20" width="10" height="20" fill="currentColor"/>
<rect x="20" y="20" width="10" height="10" fill="currentColor"/>
<rect x="40" y="20" width="10" height="20" fill="currentColor"/>
<rect x="60" y="20" width="10" height="20" fill="url(#yoinks-shade)"/>
<rect x="90" y="20" width="10" height="20" fill="url(#yoinks-shade)"/>
<rect x="120" y="20" width="10" height="20" fill="currentColor"/>
<rect x="150" y="20" width="10" height="20" fill="url(#yoinks-shade)"/>
<rect x="170" y="20" width="10" height="20" fill="url(#yoinks-shade)"/>
<rect x="180" y="20" width="10" height="10" fill="currentColor"/>
<rect x="190" y="30" width="10" height="10" fill="currentColor"/>
<rect x="210" y="20" width="10" height="10" fill="currentColor"/>
<rect x="220" y="20" width="10" height="10" fill="currentColor"/>
<rect x="230" y="20" width="10" height="20" fill="url(#yoinks-shade)"/>
<rect x="10" y="40" width="10" height="10" fill="currentColor"/>
<rect x="40" y="40" width="10" height="10" fill="currentColor"/>
<rect x="50" y="40" width="10" height="10" fill="currentColor"/>
<rect x="60" y="40" width="10" height="10" fill="currentColor"/>
<rect x="80" y="40" width="10" height="10" fill="currentColor"/>
<rect x="90" y="40" width="10" height="10" fill="currentColor"/>
<rect x="100" y="40" width="10" height="10" fill="currentColor"/>
<rect x="120" y="40" width="10" height="10" fill="currentColor"/>
<rect x="150" y="40" width="10" height="10" fill="currentColor"/>
<rect x="170" y="40" width="10" height="10" fill="currentColor"/>
<rect x="190" y="40" width="10" height="10" fill="currentColor"/>
<rect x="210" y="40" width="10" height="10" fill="currentColor"/>
<rect x="220" y="40" width="10" height="10" fill="currentColor"/>
<rect x="230" y="40" width="10" height="10" fill="currentColor"/>
    </svg>
  )
}
