import { Fragment } from 'react';
import { FLAG_LABEL, splitFlags } from '../lib/reportFlags';

/** 一般文字（不是 markdown，例如分頁按鈕）裡的國旗 emoji → CSS 小旗，見 lib/reportFlags.ts。 */
export function FlagText({ text }: { text: string }) {
  return (
    <>
      {splitFlags(text).map((part, i) =>
        'flag' in part ? (
          <span key={i} className={`rpt-flag rpt-flag-${part.flag}`} role="img" aria-label={FLAG_LABEL[part.flag]} />
        ) : (
          <Fragment key={i}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}
