package ph.pmcne.phone;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * Keeps PMC Phone signed in to the phone system while the app is in the background, so calls ring when the phone is
 * locked or another app is open. It owns the web view that holds the phone (Web). Foreground service type specialUse
 * (Android 14+: no other type covers "stay registered for incoming calls" without a push service), plus microphone
 * while a call is up, so the call keeps its microphone with the screen off.
 */
public class PhoneService extends Service {
    static final int ID = 1;
    private static PhoneService self;
    private static boolean onCall;

    static void start(Context c) {
        c.startForegroundService(new Intent(c, PhoneService.class));
    }

    /** a call started or ended: add or drop the microphone type */
    static void inCall(Context c, boolean on) {
        if (self == null || onCall == on) return;
        onCall = on;
        self.foreground();
    }

    @Override
    public void onCreate() {
        super.onCreate();
        self = this;
        Calls.channels(this);
        foreground();
        Web.get(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onDestroy() {
        self = null;
        super.onDestroy();
    }

    private void foreground() {
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE);
        Notification n = new Notification.Builder(this, Calls.CH_SERVICE)
                .setSmallIcon(R.drawable.ic_stat_phone)
                .setContentTitle("PMC Phone")
                .setContentText(onCall ? "On a call" : "Connected. Calls to your extension ring here.")
                .setOngoing(true)
                .setContentIntent(open)
                .build();
        if (Build.VERSION.SDK_INT >= 34) {
            int type = ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE;
            if (onCall) type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
            try {
                startForeground(ID, n, type);
            } catch (RuntimeException e) {
                // the microphone type is refused when the call did not start from the screen; keep the connection
                startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            }
        } else {
            startForeground(ID, n);
        }
    }
}
