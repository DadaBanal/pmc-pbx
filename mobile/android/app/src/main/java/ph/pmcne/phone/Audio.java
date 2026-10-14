package ph.pmcne.phone;

import android.content.Context;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Where a call is heard. The browser phone could not choose (Chrome on Android has no setSinkId: crbug 41276355), so
 * every call played on the loudspeaker. Here a call starts on the earpiece, or on a headset or Bluetooth if one is
 * connected, and the person can switch in the call screen's Sound control. Android 12+: setCommunicationDevice;
 * older: speakerphone and Bluetooth SCO.
 */
final class Audio {
    private static String current = "";
    private static boolean listening;

    private Audio() {}

    private static AudioManager am(Context c) { return c.getSystemService(AudioManager.class); }

    static void startCall(Context c) {
        AudioManager am = am(c);
        am.setMode(AudioManager.MODE_IN_COMMUNICATION);
        Map<String, String> r = routes(c);
        setRoute(c, r.containsKey("bluetooth") ? "bluetooth" : r.containsKey("headset") ? "headset" : "earpiece");
        if (!listening) {
            listening = true;
            am.registerAudioDeviceCallback(new AudioDeviceCallback() {
                @Override public void onAudioDevicesAdded(AudioDeviceInfo[] d) { pushRoutes(c); }
                @Override public void onAudioDevicesRemoved(AudioDeviceInfo[] d) { pushRoutes(c); }
            }, new Handler(Looper.getMainLooper()));
        }
    }

    static void endCall(Context c) {
        AudioManager am = am(c);
        if (Build.VERSION.SDK_INT >= 31) {
            am.clearCommunicationDevice();
        } else {
            am.setSpeakerphoneOn(false);
            am.stopBluetoothSco();
            am.setBluetoothScoOn(false);
        }
        am.setMode(AudioManager.MODE_NORMAL);
        current = "";
    }

    private static String kind(AudioDeviceInfo d) {
        switch (d.getType()) {
            case AudioDeviceInfo.TYPE_BUILTIN_EARPIECE: return "earpiece";
            case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER: return "speaker";
            case AudioDeviceInfo.TYPE_WIRED_HEADSET:
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
            case AudioDeviceInfo.TYPE_USB_HEADSET: return "headset";
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO: return "bluetooth";
            default:
                if (Build.VERSION.SDK_INT >= 31 && d.getType() == AudioDeviceInfo.TYPE_BLE_HEADSET) return "bluetooth";
                return "";
        }
    }

    /** id -> label of the outputs a call can use now, earpiece first */
    static Map<String, String> routes(Context c) {
        Map<String, String> out = new LinkedHashMap<>();
        AudioManager am = am(c);
        AudioDeviceInfo[] list = Build.VERSION.SDK_INT >= 31
                ? am.getAvailableCommunicationDevices().toArray(new AudioDeviceInfo[0])
                : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS);
        boolean earpiece = false;
        for (AudioDeviceInfo d : list) if (d.getType() == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE) earpiece = true;
        if (earpiece) out.put("earpiece", "Phone (earpiece)");
        out.put("speaker", "Speaker");
        for (AudioDeviceInfo d : list) {
            String k = kind(d);
            if (k.equals("headset") && !out.containsKey("headset")) out.put("headset", "Headset");
            if (k.equals("bluetooth") && !out.containsKey("bluetooth")) {
                CharSequence n = d.getProductName();
                out.put("bluetooth", "Bluetooth" + (n != null && n.length() > 0 ? ": " + n : ""));
            }
        }
        return out;
    }

    static void setRoute(Context c, String id) {
        AudioManager am = am(c);
        if (Build.VERSION.SDK_INT >= 31) {
            for (AudioDeviceInfo d : am.getAvailableCommunicationDevices()) {
                if (id.equals(kind(d)) && am.setCommunicationDevice(d)) { current = id; break; }
            }
        } else {
            switch (id) {
                case "speaker":
                    am.stopBluetoothSco();
                    am.setBluetoothScoOn(false);
                    am.setSpeakerphoneOn(true);
                    break;
                case "bluetooth":
                    am.setSpeakerphoneOn(false);
                    am.startBluetoothSco();
                    am.setBluetoothScoOn(true);
                    break;
                default:
                    am.setSpeakerphoneOn(false);
                    am.stopBluetoothSco();
                    am.setBluetoothScoOn(false);
                    break;
            }
            current = id;
        }
        pushRoutes(c);
    }

    /** tell the page what it can choose, for its Sound control */
    static void pushRoutes(Context c) {
        try {
            JSONArray a = new JSONArray();
            for (Map.Entry<String, String> e : routes(c).entrySet()) {
                a.put(new JSONObject().put("id", e.getKey()).put("label", e.getValue()));
            }
            Web.js("window.PMCApp&&PMCApp.routes(" + a + "," + JSONObject.quote(current) + ")");
        } catch (Exception e) {
            // the page keeps its last list
        }
    }
}
