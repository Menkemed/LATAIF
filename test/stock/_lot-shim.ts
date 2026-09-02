// Die Anschluesse, die `lot-queries` beim Laden braucht, aber fuer die reine Rechnung nicht ruft.
// Jeder Aufruf faellt hier auf — so kann ein Test nicht unbemerkt gegen eine erfundene Datenbank
// laufen und ein gutes Ergebnis vortaeuschen.
const nope = (name: string) => (): never => { throw new Error(`[test] ${name} must not be reached here`); };
export const getDatabase = nope('getDatabase');
export const query = nope('query');
export const trackChange = nope('trackChange');
