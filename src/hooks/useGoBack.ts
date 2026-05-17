// 2026-05-17 — Smart-Back-Button-Hook fuer Detail-Pages.
//
// Statt hart auf die List-View zurueckzuspringen (`navigate('/clients')`),
// gehen wir 1 Schritt in der History zurueck (`navigate(-1)`) — so landet
// der User bei der Seite von der er KAM (z.B. Customer-Detail → Invoice →
// Back fuehrt zurueck zur Customer, nicht zur Invoice-Liste).
//
// Edge-Case: Wenn der User die Detail-Page direkt via URL/Deep-Link geoeffnet
// hat (keine History), greift der `fallback` als sinnvoller Default.
// Erkennung: location.key === 'default' bedeutet erstes Render in der Session.

import { useNavigate, useLocation } from 'react-router-dom';
import { useCallback } from 'react';

export function useGoBack(fallback: string) {
  const navigate = useNavigate();
  const location = useLocation();
  return useCallback(() => {
    // React Router setzt location.key auf 'default' beim allerersten Render.
    // Wenn der User direkt auf eine Detail-URL kommt (Refresh, neuer Tab,
    // deep-link), gibt's keine vorherige Seite in der SPA-History → Fallback.
    if (location.key === 'default') {
      navigate(fallback);
    } else {
      navigate(-1);
    }
  }, [navigate, location.key, fallback]);
}
