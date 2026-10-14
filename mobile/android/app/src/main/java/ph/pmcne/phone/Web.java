package ph.pmcne.phone;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.MutableContextWrapper;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.net.Uri;
import android.view.ViewGroup;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * The one web view that holds the phone (https://phone.pmcne.ph/phone: the same AD sign-in and AD group gate as the
 * browser). It belongs to PhoneService, not to the screen, so the phone stays signed in to the phone system and keeps
 * ringing after the screen is closed or the app is swiped away. MainActivity borrows it while it is open.
 */
final class Web {
    static final String HOST = "phone.pmcne.ph";
    static final String HOME = "https://" + HOST + "/phone";

    private static WebView view;
    private static MutableContextWrapper ctx;
    /** the page now shown is the phone site; the bridge refuses everything otherwise */
    static volatile boolean onPhoneSite;
    /** the phone screen is in front of the user */
    static volatile boolean visible;

    private Web() {}

    static WebView peek() { return view; }

    static WebView get(Context any) {
        if (view != null) return view;
        Context app = any.getApplicationContext();
        ctx = new MutableContextWrapper(app);
        view = new WebView(ctx);
        WebSettings s = view.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setUserAgentString(s.getUserAgentString() + " PMCPhoneApp/" + version(app) + " (Android)");
        // keep the page running at full priority when no screen shows it: it is the phone's connection
        view.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        view.setBackgroundColor(0xFF080B14);
        view.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (isPhoneSite(u)) return false;
                // anything else opens in the browser, never inside the app (and never with the app's bridge)
                try {
                    Intent i = new Intent(Intent.ACTION_VIEW, u);
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    v.getContext().startActivity(i);
                } catch (Exception e) { /* no browser */ }
                return true;
            }

            @Override
            public void onPageStarted(WebView v, String url, Bitmap favicon) { onPhoneSite = isPhoneSite(Uri.parse(url)); }

            @Override
            public void onPageFinished(WebView v, String url) { onPhoneSite = isPhoneSite(Uri.parse(url)); }
        });
        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest r) {
                // the microphone, for the phone site only, and only once Android has given it to the app
                boolean ours = r.getOrigin() != null && isPhoneSite(r.getOrigin());
                boolean micOnly = r.getResources().length == 1 && PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r.getResources()[0]);
                boolean granted = app.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
                if (ours && micOnly && granted) r.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
                else r.deny();
            }
        });
        view.addJavascriptInterface(new Bridge(app), "PMCNative");
        view.loadUrl(HOME);
        return view;
    }

    static void attach(Activity a, ViewGroup parent) {
        WebView v = get(a);
        ctx.setBaseContext(a);
        if (v.getParent() instanceof ViewGroup) ((ViewGroup) v.getParent()).removeView(v);
        parent.addView(v, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    static void detach(Activity a) {
        if (view == null) return;
        if (view.getParent() instanceof ViewGroup) ((ViewGroup) view.getParent()).removeView(view);
        ctx.setBaseContext(a.getApplicationContext());
    }

    /** run script in the page, on the page's thread */
    static void js(final String code) {
        final WebView v = view;
        if (v != null) v.post(() -> v.evaluateJavascript(code, null));
    }

    static boolean isPhoneSite(Uri u) { return u != null && "https".equals(u.getScheme()) && HOST.equals(u.getHost()); }

    static String version(Context c) {
        try { return c.getPackageManager().getPackageInfo(c.getPackageName(), 0).versionName; } catch (Exception e) { return "?"; }
    }
}
