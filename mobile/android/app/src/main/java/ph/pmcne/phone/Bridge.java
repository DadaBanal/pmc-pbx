package ph.pmcne.phone;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;

import org.json.JSONObject;

/**
 * window.PMCNative in the page. One method, post(json), the same shape as the iPhone app's message handler:
 *   {type:"ready", ext, name}                                   the page has signed in and started its phone
 *   {type:"call", state:"ringing|connecting|active|idle", name, number, emergency, waiting}
 *   {type:"route", id:"earpiece|speaker|headset|bluetooth"}
 * The app answers through window.PMCApp: routes(list, current), answer(), decline().
 * Refuses everything unless the page is the phone site (Web.onPhoneSite).
 */
final class Bridge {
    private final Context app;
    private final Handler main = new Handler(Looper.getMainLooper());

    Bridge(Context app) { this.app = app; }

    @JavascriptInterface
    public void post(final String json) {
        if (!Web.onPhoneSite || json == null || json.length() > 4096) return;
        main.post(() -> handle(json));
    }

    private void handle(String json) {
        try {
            JSONObject m = new JSONObject(json);
            switch (m.optString("type")) {
                case "ready":
                    Audio.pushRoutes(app);
                    break;
                case "call":
                    Calls.state(app, m.optString("state"), m.optString("name"), m.optString("number"),
                            m.optBoolean("emergency"), m.optBoolean("waiting"));
                    break;
                case "route":
                    Audio.setRoute(app, m.optString("id"));
                    break;
                default:
                    break;
            }
        } catch (Exception e) {
            // a malformed message is ignored; the page carries on as a browser phone
        }
    }
}
