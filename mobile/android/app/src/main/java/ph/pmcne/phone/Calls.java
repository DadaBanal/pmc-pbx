package ph.pmcne.phone;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Person;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.media.ToneGenerator;
import android.net.Uri;
import android.os.Build;
import android.os.VibrationEffect;
import android.os.Vibrator;

/**
 * Ringing. An ordinary call rings like a phone call and follows the phone's own silent and Do Not Disturb settings.
 * An emergency call (dialplan *99<ext>, marked X-PMC-Priority: emergency) rings through them:
 *   - its notification channel may interrupt Do Not Disturb (NotificationChannel.setBypassDnd; takes effect once the
 *     person has allowed PMC Phone "Do Not Disturb access", which MainActivity asks for once);
 *   - the app itself plays the alarm sound on the ALARM stream, which silent mode does not mute and which Do Not
 *     Disturb lets through unless alarms have been switched off there.
 * Dada, 14 Oct 2026: "bypass notifications on the phone when emergency", "the android add the critical or emergency one".
 */
final class Calls {
    static final String CH_SERVICE = "service_v1";
    static final String CH_CALLS = "calls_v1";
    static final String CH_EMERGENCY = "emergency_v1";
    static final int ID_CALL = 2;

    private static MediaPlayer alarm;
    private static ToneGenerator tone;

    private Calls() {}

    static void channels(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        NotificationChannel svc = new NotificationChannel(CH_SERVICE, "Connected to the phone system", NotificationManager.IMPORTANCE_MIN);
        svc.setShowBadge(false);
        nm.createNotificationChannel(svc);

        NotificationChannel calls = new NotificationChannel(CH_CALLS, "Incoming calls", NotificationManager.IMPORTANCE_HIGH);
        calls.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
        calls.enableVibration(true);
        calls.setVibrationPattern(new long[] { 0, 800, 600, 800 });
        calls.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(calls);

        NotificationChannel em = new NotificationChannel(CH_EMERGENCY, "Emergency calls", NotificationManager.IMPORTANCE_HIGH);
        em.setDescription("Rings through silent mode and Do Not Disturb");
        em.setBypassDnd(true);
        em.setSound(null, null); // the app plays the alarm itself, on the alarm stream
        em.enableVibration(true);
        em.setVibrationPattern(new long[] { 0, 1000, 400, 1000 });
        em.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(em);
    }

    static void state(Context c, String state, String name, String number, boolean emergency, boolean waiting) {
        switch (state) {
            case "ringing":
                ring(c, name, number, emergency, waiting);
                break;
            case "active":
                stop(c);
                Audio.startCall(c);
                PhoneService.inCall(c, true);
                break;
            case "connecting":
                stop(c);
                break;
            default: // idle
                stop(c);
                Audio.endCall(c);
                PhoneService.inCall(c, false);
                break;
        }
    }

    private static PendingIntent screen(Context c, String action, int code) {
        Intent i = new Intent(c, MainActivity.class).setAction(action)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(c, code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static void ring(Context c, String name, String number, boolean emergency, boolean waiting) {
        stopSound(c);
        String who = name.isEmpty() ? number : (number.isEmpty() || number.equals(name) ? name : name + " (" + number + ")");
        if (who.isEmpty()) who = "Unknown caller";
        if (waiting && !emergency) {
            // call waiting: a soft beep in the call you are on, not a ringtone in your ear
            try {
                tone = new ToneGenerator(AudioManager.STREAM_VOICE_CALL, 60);
                tone.startTone(ToneGenerator.TONE_SUP_CALL_WAITING, 3000);
            } catch (RuntimeException e) { tone = null; }
        }
        PendingIntent full = screen(c, MainActivity.ACTION_SHOW, 1);
        PendingIntent answer = screen(c, MainActivity.ACTION_ANSWER, 2);
        PendingIntent decline = screen(c, MainActivity.ACTION_DECLINE, 3);
        Notification.Builder b = new Notification.Builder(c, emergency ? CH_EMERGENCY : CH_CALLS)
                .setSmallIcon(R.drawable.ic_stat_phone)
                .setContentTitle(emergency ? "EMERGENCY CALL" : waiting ? "Call waiting" : "Incoming call")
                .setContentText(who)
                .setCategory(Notification.CATEGORY_CALL)
                .setOngoing(true)
                .setAutoCancel(false)
                .setContentIntent(full);
        if (!waiting || emergency) b.setFullScreenIntent(full, true);
        if (Build.VERSION.SDK_INT >= 31) {
            b.setStyle(Notification.CallStyle.forIncomingCall(new Person.Builder().setName(who).setImportant(true).build(), decline, answer));
        } else {
            b.addAction(new Notification.Action.Builder(null, "Decline", decline).build());
            b.addAction(new Notification.Action.Builder(null, waiting ? "Hold and answer" : "Answer", answer).build());
        }
        Notification n = b.build();
        if (!waiting || emergency) n.flags |= Notification.FLAG_INSISTENT; // the ringtone repeats until answered or ended
        c.getSystemService(NotificationManager.class).notify(ID_CALL, n);
        if (emergency) playAlarm(c);
    }

    private static void playAlarm(Context c) {
        try {
            Uri u = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
            if (u == null) u = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
            alarm = new MediaPlayer();
            alarm.setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
            alarm.setDataSource(c, u);
            alarm.setLooping(true);
            alarm.prepare();
            alarm.start();
        } catch (Exception e) {
            alarm = null;
        }
        Vibrator v = c.getSystemService(Vibrator.class);
        if (v != null && v.hasVibrator()) {
            v.vibrate(VibrationEffect.createWaveform(new long[] { 0, 1000, 400, 1000 }, 0),
                    new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build());
        }
    }

    static void stop(Context c) {
        stopSound(c);
        c.getSystemService(NotificationManager.class).cancel(ID_CALL);
    }

    private static void stopSound(Context c) {
        if (alarm != null) {
            try { alarm.stop(); } catch (RuntimeException e) { /* not started */ }
            alarm.release();
            alarm = null;
        }
        if (tone != null) { tone.release(); tone = null; }
        Vibrator v = c.getSystemService(Vibrator.class);
        if (v != null) v.cancel();
    }
}
