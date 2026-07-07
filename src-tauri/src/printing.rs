// Windows Raw-Printing: schickt Bytes (ZPL) am Druckertreiber vorbei direkt
// an den Spooler (Datatype "RAW"). Repliziert die bewährte winspool-Sequenz.
// Nur unter Windows kompiliert (siehe `#[cfg(windows)] mod printing;` in lib.rs).

use std::ptr;

type Handle = *mut core::ffi::c_void;
type Bool = i32;
type Dword = u32;

#[repr(C)]
struct DocInfo1W {
    p_doc_name: *const u16,
    p_output_file: *const u16,
    p_datatype: *const u16,
}

#[link(name = "winspool")]
extern "system" {
    fn OpenPrinterW(
        p_printer_name: *const u16,
        ph_printer: *mut Handle,
        p_default: *mut core::ffi::c_void,
    ) -> Bool;
    fn ClosePrinter(h_printer: Handle) -> Bool;
    fn StartDocPrinterW(h_printer: Handle, level: Dword, p_doc_info: *mut DocInfo1W) -> Dword;
    fn EndDocPrinter(h_printer: Handle) -> Bool;
    fn StartPagePrinter(h_printer: Handle) -> Bool;
    fn EndPagePrinter(h_printer: Handle) -> Bool;
    fn WritePrinter(
        h_printer: Handle,
        p_buf: *const core::ffi::c_void,
        cb_buf: Dword,
        pc_written: *mut Dword,
    ) -> Bool;
}

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Schickt `data` als RAW-Job an den Drucker `printer`. Gibt die Anzahl
/// geschriebener Bytes zurück oder eine Fehlermeldung (für die UI).
pub fn print_raw(printer: &str, data: &[u8]) -> Result<u32, String> {
    if printer.trim().is_empty() {
        return Err("Kein Druckername angegeben.".to_string());
    }
    if data.is_empty() {
        return Err("Keine Druckdaten (leeres ZPL).".to_string());
    }

    let printer_w = to_wide(printer);
    let mut doc_name = to_wide("LATAIF-ZPL");
    let mut datatype = to_wide("RAW");

    unsafe {
        let mut h: Handle = ptr::null_mut();
        if OpenPrinterW(printer_w.as_ptr(), &mut h, ptr::null_mut()) == 0 || h.is_null() {
            return Err(format!(
                "Drucker '{}' konnte nicht geöffnet werden (OpenPrinter).",
                printer
            ));
        }

        let mut di = DocInfo1W {
            p_doc_name: doc_name.as_mut_ptr(),
            p_output_file: ptr::null(),
            p_datatype: datatype.as_mut_ptr(),
        };

        let job = StartDocPrinterW(h, 1, &mut di);
        if job == 0 {
            ClosePrinter(h);
            return Err("StartDocPrinter fehlgeschlagen.".to_string());
        }
        if StartPagePrinter(h) == 0 {
            EndDocPrinter(h);
            ClosePrinter(h);
            return Err("StartPagePrinter fehlgeschlagen.".to_string());
        }

        let mut written: Dword = 0;
        let ok = WritePrinter(
            h,
            data.as_ptr() as *const core::ffi::c_void,
            data.len() as Dword,
            &mut written,
        );

        EndPagePrinter(h);
        EndDocPrinter(h);
        ClosePrinter(h);

        if ok == 0 {
            return Err("WritePrinter fehlgeschlagen.".to_string());
        }
        Ok(written)
    }
}
