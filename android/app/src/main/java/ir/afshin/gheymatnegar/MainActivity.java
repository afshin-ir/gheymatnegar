package ir.afshin.gheymatnegar;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DocumentExportPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
