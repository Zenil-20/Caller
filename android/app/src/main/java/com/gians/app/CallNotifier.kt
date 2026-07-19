package com.gians.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import androidx.core.app.NotificationCompat
import androidx.core.app.Person

/**
 * Builds the notifications that carry a call, and — via a full-screen intent —
 * the ringing call screen itself.
 *
 * The full-screen intent is the only mechanism on Android that lets an app take
 * over the display for an incoming call, and it is why this native shell exists
 * at all: a service worker in the browser has no equivalent and can never do
 * more than post a notification.
 */
object CallNotifier {

    private const val CHANNEL_CALLS = "gians_incoming_calls"
    private const val CHANNEL_MISSED = "gians_missed_calls"

    /** One live call at a time, so a fixed id keeps replacing rather than stacking. */
    private const val NOTIFICATION_ID_CALL = 1001

    fun showIncomingCall(
        context: Context,
        callId: String,
        callerName: String,
        callerUsername: String,
        actionToken: String,
        expiresAt: Long?,
    ) {
        ensureChannels(context)

        val fullScreen = PendingIntent.getActivity(
            context,
            callId.hashCode(),
            IncomingCallActivity.intent(context, callId, callerName, callerUsername, actionToken, expiresAt),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        // Answering needs the WebRTC stack, which only exists in the web app, so
        // this hands off to the TWA rather than trying to take the call natively.
        val answer = PendingIntent.getActivity(
            context,
            callId.hashCode() + 1,
            Intent(context, GiansLauncherActivity::class.java).apply {
                putExtra(GiansLauncherActivity.EXTRA_CALL_ID, callId)
                putExtra(GiansLauncherActivity.EXTRA_ACTION, "accept")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        // Declining needs nothing but the token that arrived in the payload, so
        // it resolves without ever opening the app or unlocking the phone.
        val decline = PendingIntent.getBroadcast(
            context,
            callId.hashCode() + 2,
            Intent(context, CallActionReceiver::class.java).apply {
                action = CallActionReceiver.ACTION_DECLINE
                putExtra(CallActionReceiver.EXTRA_CALL_ID, callId)
                putExtra(CallActionReceiver.EXTRA_ACTION_TOKEN, actionToken)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val caller = Person.Builder()
            .setName(callerName)
            .setImportant(true)
            .build()

        val notification = NotificationCompat.Builder(context, CHANNEL_CALLS)
            .setSmallIcon(R.drawable.ic_call)
            .setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, decline, answer))
            .setContentText(if (callerUsername.isEmpty()) "gians voice call" else "@$callerUsername")
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            // Non-dismissible while ringing: swiping a call away should be a
            // decline, not a way to lose it silently.
            .setOngoing(true)
            // Below API 31 CallStyle only ranks as a call if it is colorized or
            // tied to a foreground service. Colorized is far the lighter of the two.
            .setColorized(true)
            .setFullScreenIntent(fullScreen, true)
            .build()

        NotificationManagerCompatSafe.notify(context, NOTIFICATION_ID_CALL, notification)
    }

    fun showMissedCall(context: Context, callId: String, callerName: String) {
        ensureChannels(context)

        val open = PendingIntent.getActivity(
            context,
            callId.hashCode() + 3,
            Intent(context, GiansLauncherActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val notification = NotificationCompat.Builder(context, CHANNEL_MISSED)
            .setSmallIcon(R.drawable.ic_call)
            .setContentTitle("Missed call from $callerName")
            .setContentText("Tap to call back")
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setAutoCancel(true)
            .setContentIntent(open)
            .build()

        NotificationManagerCompatSafe.notify(context, callId.hashCode(), notification)
    }

    /**
     * Takes the call down everywhere: the notification, and the call screen if it
     * is already up. Both are needed — cancelling the notification alone leaves a
     * ringing Activity on screen for a call that no longer exists.
     */
    fun cancel(context: Context, callId: String) {
        context.getSystemService(NotificationManager::class.java)
            .cancel(NOTIFICATION_ID_CALL)

        context.sendBroadcast(
            Intent(IncomingCallActivity.ACTION_CALL_ENDED)
                .putExtra(IncomingCallActivity.EXTRA_CALL_ID, callId)
                .setPackage(context.packageName),
        )
    }

    /**
     * IMPORTANCE_HIGH is not cosmetic here: the system refuses to fire a
     * full-screen intent from a channel below it, so getting this wrong turns
     * every call into a silent banner.
     */
    private fun ensureChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)

        if (manager.getNotificationChannel(CHANNEL_CALLS) == null) {
            val ringtone = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
            val attributes = AudioAttributes.Builder()
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                // Plays on the ring stream, so it follows the phone's ringer
                // volume and silent mode rather than the notification volume.
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .build()

            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_CALLS, "Incoming calls", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "Rings when someone calls you"
                    setSound(ringtone, attributes)
                    enableVibration(true)
                    vibrationPattern = longArrayOf(0, 1000, 800, 1000, 800, 1000)
                    lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                    setBypassDnd(true)
                }
            )
        }

        if (manager.getNotificationChannel(CHANNEL_MISSED) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_MISSED, "Missed calls", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "Tells you about calls you missed"
                }
            )
        }
    }
}

/**
 * Posting can throw on Android 13+ if the notification permission was never
 * granted. Losing a call is bad; crashing the process that was trying to deliver
 * it is worse, and takes the app's chance to recover with it.
 */
private object NotificationManagerCompatSafe {
    fun notify(context: Context, id: Int, notification: Notification) {
        try {
            context.getSystemService(NotificationManager::class.java).notify(id, notification)
        } catch (_: SecurityException) {
            // Nothing useful left to do — the user has denied notifications.
        }
    }
}
