import * as React from 'react';
import mark from '../../assets/brand/nexus-mark-256.png';

/** A generated image, rendered as a mask so the host can select the ink color. */
export function NativeBrandMark({ size = 24 }: { size?: number; className?: string }) {
  return <span role="img" aria-label="DSH Nexus" data-nexus-brand-mark="" style={{
    display: 'inline-block', flex: 'none', width: size, height: size,
    backgroundColor: 'var(--nexus-brand-color, #c66a4a)',
    maskImage: `url("${mark}")`, maskSize: 'contain', maskRepeat: 'no-repeat', maskPosition: 'center',
  }} />;
}

