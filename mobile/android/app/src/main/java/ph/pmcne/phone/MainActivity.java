package ph.pmcne.phone;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.window.OnBackInvokedDispatcher;

import java.util.ArrayList;
import java.util.List;

/**
 * The phone screen: shows the phone's web view (owned by PhoneService), asks once for what the phone needs, and turns
 * the incoming-call notification's Answer and Decline into the page's own answer and decline.
 */
public class MainActivity extends Activity {
    static final String ACTION_SHOW = "ph.pmcne.phone.SHOW";
    static final String ACTION_ANSWER = "ph.pmcne.phone.ANSWER";
    static final String ACTION_DECLINE = "ph.pmcne.phone.DECLINE";

    private FrameLayout root;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        root = new FrameLayout(this);
        root.setFitsSystemWindows(true);
        root.setBackgroundColor(0xFF080B14);
        setContentView(root);
        Calls.channels(this);
        askPermissions();
        PhoneService.start(this);
        Web.attach(this, root);
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::back);
        }
        handle(getIntent());
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() { back(); }

    /** back goes back in the page; at its start the app goes to the background and keeps the phone connected */
    private void back() {
        WebView w = Web.peek();
        if (w != null && w.canGoBack()) w.goBack();
        else moveTaskToBack(true);
    }

    @Override
    protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        setIntent(i);
        handle(i);
    }

    @Override
    protected void onResume() {
        super.onResume();
        Web.visible = true;
    }

    @Override
    protected void onPause() {
        Web.visible = false;
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        Web.detach(this);
        super.onDestroy();
    }

    private void handle(Intent i) {
        if (i == null || i.getAction() == null) return;
        switch (i.getAction()) {
            case ACTION_ANSWER:
                Web.js("window.PMCApp&&PMCApp.answer()");
                break;
            case ACTION_DECLINE:
                Web.js("window.PMCApp&&PMCApp.decline()");
                moveTaskToBack(true);
                break;
            default:
                break;
        }
    }

    private void askPermissions() {
        List<String> need = new ArrayList<>();
        need.add(Manifest.permission.RECORD_AUDIO);
        if (Build.VERSION.SDK_INT >= 33) need.add(Manifest.permission.POST_NOTIFICATIONS);
        if (Build.VERSION.SDK_INT >= 31) need.add(Manifest.permission.BLUETOOTH_CONNECT);
        List<String> ask = new ArrayList<>();
        for (String p : need) if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) ask.add(p);
        if (!ask.isEmpty()) {
            requestPermissions(ask.toArray(new String[0]), 1);
            return; // the special settings below are offered on a later start, one at a time
        }
        offerSpecialSettings();
    }

    /** the three settings Android keeps outside the normal permission prompt, each offered once and explained */
    private void offerSpecialSettings() {
        SharedPreferences p = getSharedPreferences("pmc", MODE_PRIVATE);
        NotificationManager nm = getSystemService(NotificationManager.class);
        PowerManager pm = getSystemService(PowerManager.class);
        if (!p.getBoolean("asked-battery", false) && !pm.isIgnoringBatteryOptimizations(getPackageName())) {
            p.edit().putBoolean("asked-battery", true).apply();
            offer("Stay connected", "So calls ring while PMC Phone is in the background, allow it to run without battery limits.",
                    new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())));
        } else if (Build.VERSION.SDK_INT >= 34 && !p.getBoolean("asked-fullscreen", false) && !nm.canUseFullScreenIntent()) {
            p.edit().putBoolean("asked-fullscreen", true).apply();
            offer("Show calls on the lock screen", "So an incoming call fills the screen like a phone call, allow PMC Phone to use full screen notifications.",
                    new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + getPackageName())));
        } else if (!p.getBoolean("asked-dnd", false) && !nm.isNotificationPolicyAccessGranted()) {
            p.edit().putBoolean("asked-dnd", true).apply();
            offer("Emergency calls", "So an emergency call can ring through Do Not Disturb, allow PMC Phone Do Not Disturb access. Ordinary calls still follow your settings.",
                    new Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS));
        }
    }

    private void offer(String title, String why, Intent settings) {
        new AlertDialog.Builder(this)
                .setTitle(title)
                .setMessage(why)
                .setPositiveButton("Open settings", (d, w) -> {
                    try { startActivity(settings); } catch (Exception e) { /* this phone has no such screen */ }
                })
                .setNegativeButton("Not now", null)
                .show();
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        offerSpecialSettings();
    }
}
