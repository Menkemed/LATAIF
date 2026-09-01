// DATA-ROOT-B1a — die Frage, die vor allem anderen steht.
//
// Ist das Kontrollverzeichnis dieser Installation leer, legt der Kern nichts mehr von selbst an: er
// meldet, dass die Entscheidung aussteht. Der Bildschirm muss das WISSEN, bevor er irgendetwas tut,
// denn sein `initDatabase()` wuerde genau die leere Datenbank erzeugen, die es zu vermeiden gilt —
// und damit die Frage beantworten, ohne sie gestellt zu haben.
//
// Deshalb ist das hier die erste Zeile des Starts. Sie fragt und veraendert nichts.

import { invoke } from '@tauri-apps/api/core';

/** Läuft die App überhaupt im Desktop-Kern? Im Browser gibt es keine Datenwurzel und keine Frage. */
function inDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Steht der Start noch vor der Entscheidung?
 *
 * Nur wahr, wenn der Kern genau das sagt. Jede Unsicherheit — kein Desktop, ein unbekanntes
 * Kommando, ein Fehler — ist ein `false`: eine bestehende Installation darf niemals faelschlich in
 * die Weiche laufen, das waere aus einem Schutz eine Sperre.
 */
export async function isFirstRunPending(): Promise<boolean> {
  if (!inDesktop()) return false;
  try {
    return (await invoke<boolean>('first_run_pending')) === true;
  } catch {
    return false;
  }
}

/**
 * `Set up new installation` — die bewusste Antwort.
 *
 * Ruft die kanonische Bootstrap-Primitive im Kern auf und gibt die neue Kennung zurueck. Danach
 * muss der Prozess neu starten: erst der naechste Start ist eine gewoehnliche Installation.
 */
export async function setUpNewInstallation(): Promise<string> {
  return invoke<string>('first_run_setup_new');
}
