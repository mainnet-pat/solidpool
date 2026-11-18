'use client';

import { useEffect } from 'react';
import { MARKUP } from '../components/markup';
import { mountUi } from '../components/ui';

export default function Page() {
  useEffect(() => {
    mountUi().catch((error: unknown) => console.error('UI mount failed', error));
  }, []);
  return <div dangerouslySetInnerHTML={{ __html: MARKUP }} />;
}
