package io.github.wangrunqiao0915.folioread;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.content.IntentFilter;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.Assert.*;

/** Runs with Wi-Fi and mobile data disabled in CI. No account or model key is needed. */
@RunWith(AndroidJUnit4.class)
public class ReaderSmokeTest {
    private ActivityScenario<MainActivity> scenario;
    private String js(String code) throws Exception {
        AtomicReference<String> value = new AtomicReference<>();
        CountDownLatch done = new CountDownLatch(1);
        scenario.onActivity(activity -> activity.getReaderWebView().evaluateJavascript(code, result -> {
            value.set(result); done.countDown();
        }));
        assertTrue("JavaScript result timeout", done.await(10, TimeUnit.SECONDS));
        return value.get();
    }
    private void until(String condition) throws Exception {
        long deadline = System.currentTimeMillis() + 90000;
        while (System.currentTimeMillis() < deadline) {
            if ("true".equals(js("Boolean(" + condition + ")"))) return;
            Thread.sleep(150);
        }
        fail("Timed out: " + condition + "\nPage: " + js("document.body.innerText"));
    }
    @Test public void offlinePdfImportNotesPersistenceAndNativeCancellation() throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        try (ActivityScenario<MainActivity> current = ActivityScenario.launch(MainActivity.class)) {
            scenario = current;
            until("window.FolioPlatform && document.querySelector('[data-act=import]')");
            assertEquals("true", js("FolioPlatform.bundledAssets"));
            assertTrue(js("FolioPDF.BASE").contains("appassets.androidplatform.net/assets/vendor/pdfjs/"));
            // Both cancellations must resolve the callback, allowing the next picker.
            IntentFilter openFilter = new IntentFilter(Intent.ACTION_OPEN_DOCUMENT);
            openFilter.addCategory(Intent.CATEGORY_OPENABLE); openFilter.addDataType("*/*");
            Instrumentation.ActivityMonitor openMonitor = instrumentation.addMonitor(openFilter,
                    new Instrumentation.ActivityResult(Activity.RESULT_CANCELED, null), true);
            for (int i = 0; i < 2; i++) {
                CountDownLatch returned = new CountDownLatch(1);
                AtomicBoolean cancelled = new AtomicBoolean();
                scenario.onActivity(activity -> activity.getReaderWebView().getWebChromeClient().onShowFileChooser(
                        activity.getReaderWebView(), uris -> { cancelled.set(uris == null); returned.countDown(); }, null));
                assertTrue("Cancelled picker callback", returned.await(10, TimeUnit.SECONDS));
                assertTrue(cancelled.get());
            }
            assertEquals(2, openMonitor.getHits());
            instrumentation.removeMonitor(openMonitor);
            // Supply a File through the real web import handler; PDF parsing and worker stay real.
            js("(() => { const raw=atob('JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggNjEgPj4Kc3RyZWFtCkJUIC9GMSAxOCBUZiA3MiA3MjAgVGQgKEZvbGlvIG9mZmxpbmUgcGVyc2lzdGVuY2UgdGVzdCkgVGogRVQKZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDMxMSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQyMgolJUVPRgo='); const file=new File([Uint8Array.from(raw,c=>c.charCodeAt(0))], 'offline-smoke.pdf', {type:'application/pdf'});const dt=new DataTransfer();dt.items.add(file);const input=document.querySelector('#importFile');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true})); })()");
            until("document.querySelector('#paper') && document.querySelector('#paper').textContent.includes('Folio offline persistence test')");
            js("document.querySelector('[data-act=paperNotes]').click()");
            until("document.querySelector('[data-act=addNote]')");
            js("document.querySelector('[data-act=addNote]').click()");
            until("document.querySelector('#noteBody')");
            js("document.querySelector('#noteBody').value='offline note survives recreation';document.querySelector('#saveNote').click()");
            until("!document.querySelector('#sheet').open");
            js("window.__persisted=false;FolioStorage.all().then(async papers=>{const p=papers.find(x=>!x.demo); const source=await FolioStorage.source(p.paper_id);window.__persisted=!!source.blob && Object.values(p.reader.notes).some(n=>n.body==='offline note survives recreation');})");
            until("window.__persisted");
            js("document.querySelector('[data-act=toc]').click()");
            until("document.querySelector('#sheet').open");
            scenario.onActivity(MainActivity::onBackPressed);
            until("!document.querySelector('#sheet').open && document.body.classList.contains('reader-mode')");
            scenario.recreate();
            until("document.querySelector('[data-open]')");
            js("document.querySelector('[data-open]').click()");
            until("document.querySelector('#paper') && document.querySelector('#paper').textContent.includes('Folio offline persistence test')");
            js("document.querySelector('[data-act=paperNotes]').click()");
            until("document.querySelector('#sheetBody').textContent.includes('offline note survives recreation')");
            // Saving is also mediated by a system picker; cancellation must not claim success.
            IntentFilter saveFilter = new IntentFilter(Intent.ACTION_CREATE_DOCUMENT);
            saveFilter.addCategory(Intent.CATEGORY_OPENABLE); saveFilter.addDataType("application/json");
            Instrumentation.ActivityMonitor saveMonitor = instrumentation.addMonitor(saveFilter,
                    new Instrumentation.ActivityResult(Activity.RESULT_CANCELED, null), true);
            js("window.__saveCancelled=false;FolioPlatform.saveBlob(new Blob(['{}'],{type:'application/json'}),'test.json').then(saved=>window.__saveCancelled=!saved)");
            until("window.__saveCancelled");
            assertEquals(1, saveMonitor.getHits());
            instrumentation.removeMonitor(saveMonitor);
        }
    }
}
