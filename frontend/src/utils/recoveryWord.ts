/** Match server normalization without storing the recovery secret outside the form. */
export function normalizeRecoveryWord(value:string):string {
  return value.normalize('NFKC').trim().replace(/\s+/gu,' ').toLowerCase().replace(/ß/g,'ss').replace(/ς/g,'σ');
}

export function recoveryWordError(word:string,repeat:string,password:string,min=12,max=256):string|null {
  const normalized=normalizeRecoveryWord(word);
  if(normalized.length<min)return `Секретное слово — минимум ${min} символов после удаления лишних пробелов`;
  if(normalized.length>max)return `Секретное слово — максимум ${max} символов`;
  if(normalized!==normalizeRecoveryWord(repeat))return 'Секретные слова не совпадают';
  if(normalized===normalizeRecoveryWord(password))return 'Секретное слово должно отличаться от пароля';
  return null;
}
