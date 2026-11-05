// ════════════════════════════════════════════════════════════════════════════
// LIST NAVIGATION UX (v0.8.98) — eine gemeinsame Lösung für alle Listen.
//
// `useListState` ersetzt `useState` für Suche, Filter, Sortierung und Ansicht einer Liste: beim Verlassen merkt es
// den Wert für den aktuellen Verlaufsschritt, bei der Rückkehr per „Back" (POP) kommt genau dieser Wert zurück.
// Eine normale Navigation zur Liste (Seitenleiste, Link) beginnt frisch — sie ist ein neuer Verlaufsschritt.
//
// `useListScrollRestore` (benutzt von `PageLayout`, also von jeder Seite) macht dasselbe mit der Scroll-Position:
// erst wiederherstellen, wenn der Inhalt so weit gerendert ist, dass die Position erreichbar ist (oder sich nicht
// mehr ändert — dann auf die letzte gültige Position begrenzt). Solange wartet der Inhalt unsichtbar, damit nichts
// sichtbar nach oben springt.
// ════════════════════════════════════════════════════════════════════════════
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { clampScrollTop, listNavId, listNavSnapshot, listReturnAction, recordNavVisit, rememberListNav } from '@/core/ui/list-nav-memory';

/** Die Verlaufsstelle, die der Router in `history.state.idx` führt. */
function historyIdx(): unknown {
  return (window.history.state as { idx?: unknown } | null)?.idx;
}

/** Schreibt mit, welche Seite an welcher Verlaufsstelle steht (einmal, in der immer sichtbaren Seitenleiste). */
export function useNavigationTrail(): void {
  const location = useLocation();
  useEffect(() => { recordNavVisit(historyIdx(), location.pathname); }, [location.key, location.pathname]);
}

/**
 * Nach dem Löschen eines Eintrags: kam man direkt aus der Liste, geht es dorthin zurück — mit Suche, Filtern und
 * Position (auf die kürzere Liste begrenzt). In jedem anderen Fall frisch zur Liste, genau wie bisher.
 */
export function useReturnToList(listPath: string): () => void {
  const navigate = useNavigate();
  return useCallback(() => {
    if (listReturnAction(historyIdx(), listPath) === 'back') navigate(-1);
    else navigate(listPath);
  }, [navigate, listPath]);
}

/** So lange darf der Inhalt ruhig bleiben, bevor auf die erreichbare Position begrenzt wird (Liste kürzer geworden). */
const QUIET_MS = 350;
/** Spätestens dann wird wiederhergestellt (auf die erreichbare Position), auch wenn noch Daten kommen. */
const MAX_WAIT_MS = 2500;

function useEntryId(): { id: string; isBack: boolean } {
  const location = useLocation();
  const navType = useNavigationType();
  return { id: listNavId(location.pathname, location.key), isBack: navType === 'POP' };
}

/**
 * Wie `useState`, aber für einen Listenzustand (Suche, Filter, Sortierung, Ansicht): nach „Back" ist der Wert wieder
 * da, nach normaler Navigation gilt `initial`. `field` muss je Seite eindeutig sein.
 */
export function useListState<T>(field: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const { id, isBack } = useEntryId();
  const [value, setValue] = useState<T>(() => {
    if (isBack) {
      const s = listNavSnapshot(id);
      if (s && Object.prototype.hasOwnProperty.call(s.values, field)) return s.values[field] as T;
    }
    return typeof initial === 'function' ? (initial as () => T)() : initial;
  });
  const latest = useRef({ id, value });
  useLayoutEffect(() => { latest.current = { id, value }; });
  useEffect(() => () => { rememberListNav(latest.current.id, { values: { [field]: latest.current.value } }); }, [field]);
  return [value, setValue];
}

/**
 * Scroll-Position des Seiteninhalts `ref` je Verlaufsschritt. Gibt `true` zurück, solange eine Wiederherstellung
 * wartet (der Inhalt soll dann unsichtbar bleiben).
 */
export function useListScrollRestore(ref: RefObject<HTMLElement | null>): boolean {
  const { id, isBack } = useEntryId();
  const idRef = useRef(id);
  useLayoutEffect(() => { idRef.current = id; });
  const lastTop = useRef(0);
  const [target] = useState<number>(() => (isBack ? listNavSnapshot(id)?.scrollTop ?? 0 : 0));
  const [pending, setPending] = useState(target > 0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = (): void => { lastTop.current = el.scrollTop; };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [ref]);

  useEffect(() => () => { rememberListNav(idRef.current, { scrollTop: lastTop.current }); }, []);

  useLayoutEffect(() => {
    if (!pending) return;
    const el = ref.current;
    if (!el) { setPending(false); return; }
    let finished = false;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    let limit: ReturnType<typeof setTimeout> | undefined;
    let observer: ResizeObserver | null = null;
    const stop = (): void => { finished = true; observer?.disconnect(); clearTimeout(quiet); clearTimeout(limit); };
    const finish = (): void => {
      if (finished) return;
      stop();
      el.scrollTop = clampScrollTop(target, el.scrollHeight, el.clientHeight);
      lastTop.current = el.scrollTop;
      setPending(false);
    };
    const check = (): void => {
      if (finished) return;
      if (el.scrollHeight - el.clientHeight >= target) { finish(); return; }
      clearTimeout(quiet);
      quiet = setTimeout(finish, QUIET_MS);
    };
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(check);
      for (const child of Array.from(el.children)) observer.observe(child);
    }
    limit = setTimeout(finish, MAX_WAIT_MS);
    check();
    return stop;
  }, [pending, target, ref]);

  return pending;
}
