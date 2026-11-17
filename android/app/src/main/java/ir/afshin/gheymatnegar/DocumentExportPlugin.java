package ir.afshin.gheymatnegar;

import android.app.Activity;
import android.content.Intent;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/** Save through Android's Storage Access Framework without broad storage permissions. */
@CapacitorPlugin(name = "DocumentExport")
public class DocumentExportPlugin extends Plugin {
    private boolean saving;

    @PluginMethod
    public void save(PluginCall call) {
        String filename = call.getString("filename");
        String text = call.getString("text");
        if (filename == null || text == null) {
            call.reject("Missing filename or text");
            return;
        }
        if (saving) {
            call.reject("A document picker is already open");
            return;
        }
        saving = true;
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(call.getString("mimeType", "application/json"));
        intent.putExtra(Intent.EXTRA_TITLE, filename);
        try {
            startActivityForResult(call, intent, "documentCreated");
        } catch (Exception error) {
            saving = false;
            call.reject("Cannot open document picker", error);
        }
    }

    @ActivityCallback
    private void documentCreated(PluginCall call, ActivityResult result) {
        if (call == null) { saving = false; return; }
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            saving = false;
            call.resolve(new JSObject().put("saved", false));
            return;
        }
        getBridge().execute(() -> {
            try (OutputStream output = getContext().getContentResolver().openOutputStream(data.getData(), "wt")) {
                if (output == null) throw new java.io.IOException("Cannot open document");
                output.write(call.getString("text", "").getBytes(StandardCharsets.UTF_8));
                output.flush();
            } catch (Exception error) {
                saving = false;
                call.reject("Cannot save document", error);
                return;
            }
            saving = false;
            call.resolve(new JSObject().put("saved", true));
        });
    }
}
