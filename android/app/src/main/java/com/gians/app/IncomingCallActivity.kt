package com.gians.app

import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.Ringtone
import android.media.RingtoneManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.view.WindowManager
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.gians.app.databinding.ActivityIncomingCallBinding

/**
 * The ringing call screen: the thing a notification alone can never be.
 *
 * Launched by the full-screen intent on CallNotifier's notification, so it comes
 * up over the lock screen with the display woken, the way a native dialler does.
 * It only rings — answering hands straight over to the web app, which owns the
 * WebRTC stack.
 */
class IncomingCallActivity : AppCompatActivity() {

    private lateinit var binding: ActivityIncomingCallBinding

    private var ringtone: Ringtone? = null
    private var vibrator: Vibrator? = null
    private val handler = Handler(Looper.getMainLooper())

    private lateinit var callId: String
    private var actionToken: String = ""

    /** Closes the screen when the call ends from anywhere else. */
    private val callEndedReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.getStringExtra(EXTRA_CALL_ID) == callId) finishAndRemoveTask()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        showOverLockScreen()

        binding = ActivityIncomingCallBinding.inflate(layoutInflater)
        setContentView(binding.root)

        callId = intent.getStringExtra(EXTRA_CALL_ID) ?: run { finish(); return }
        actionToken = intent.getStringExtra(EXTRA_ACTION_TOKEN).orEmpty()

        val callerName = intent.getStringExtra(EXTRA_CALLER_NAME) ?: "Unknown caller"
        val callerUsername = intent.getStringExtra(EXTRA_CALLER_USERNAME).orEmpty()

        binding.callerName.text = callerName
        binding.callerUsername.text = if (callerUsername.isEmpty()) "gians voice call" else "@$callerUsername"
        binding.callerAvatar.text = callerName.take(1).uppercase()

        binding.answerButton.setOnClickListener { answer() }
        binding.declineButton.setOnClickListener { decline() }

        ContextCompat.registerReceiver(
            this,
            callEndedReceiver,
            IntentFilter(ACTION_CALL_ENDED),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )

        startRinging()
        scheduleExpiry(intent.getLongExtra(EXTRA_EXPIRES_AT, 0L))
    }

    /**
     * The manifest already declares showWhenLocked and turnScreenOn, which is
     * what actually wins the race against the first frame. These calls are the
     * belt to that pair of braces, plus the keyguard dismissal the manifest
     * cannot express.
     */
    private fun showOverLockScreen() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // Only lifts an insecure keyguard. With a PIN or biometric set the call
        // screen still shows over the lock screen, which is what matters — the
        // user just authenticates if answering takes them into the app.
        getSystemService(KeyguardManager::class.java)?.requestDismissKeyguard(this, null)
    }

    private fun startRinging() {
        val audio = getSystemService(AudioManager::class.java)

        if (audio.ringerMode != AudioManager.RINGER_MODE_SILENT) {
            val uri = RingtoneManager.getActualDefaultRingtoneUri(this, RingtoneManager.TYPE_RINGTONE)
                ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)

            ringtone = RingtoneManager.getRingtone(this, uri)?.apply {
                audioAttributes = AudioAttributes.Builder()
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .build()

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    isLooping = true
                }
                play()
            }

            // Ringtone.isLooping only exists from API 28. Below that, nudge it
            // back to life instead of ringing exactly once and going quiet.
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
                handler.post(object : Runnable {
                    override fun run() {
                        val tone = ringtone ?: return
                        if (!tone.isPlaying) tone.play()
                        handler.postDelayed(this, 1000)
                    }
                })
            }
        }

        // Vibrate on both normal and vibrate-only; silent means silent.
        if (audio.ringerMode != AudioManager.RINGER_MODE_SILENT) {
            startVibrating()
        }
    }

    private fun startVibrating() {
        vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            getSystemService(VibratorManager::class.java)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            getSystemService(Vibrator::class.java)
        }

        val pattern = longArrayOf(0, 1000, 800)
        vibrator?.vibrate(VibrationEffect.createWaveform(pattern, 0))
    }

    private fun stopRinging() {
        handler.removeCallbacksAndMessages(null)
        ringtone?.takeIf { it.isPlaying }?.stop()
        ringtone = null
        vibrator?.cancel()
        vibrator = null
    }

    /**
     * A call screen that outlives the call is worse than no call screen: the
     * phone rings on with nothing behind it. The server stops ringing at
     * RING_TIMEOUT_MS, so match it and close.
     */
    private fun scheduleExpiry(expiresAt: Long) {
        val remaining = if (expiresAt > 0) expiresAt - System.currentTimeMillis() else 45_000L
        if (remaining <= 0) { finishAndRemoveTask(); return }
        handler.postDelayed({ finishAndRemoveTask() }, remaining)
    }

    private fun answer() {
        stopRinging()
        CallNotifier.cancel(this, callId)

        startActivity(
            Intent(this, GiansLauncherActivity::class.java).apply {
                putExtra(GiansLauncherActivity.EXTRA_CALL_ID, callId)
                putExtra(GiansLauncherActivity.EXTRA_ACTION, "accept")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            }
        )
        finishAndRemoveTask()
    }

    private fun decline() {
        stopRinging()
        CallActionReceiver.declineInBackground(applicationContext, callId, actionToken)
        finishAndRemoveTask()
    }

    override fun onDestroy() {
        stopRinging()
        runCatching { unregisterReceiver(callEndedReceiver) }
        super.onDestroy()
    }

    companion object {
        const val ACTION_CALL_ENDED = "com.gians.app.CALL_ENDED"
        const val EXTRA_CALL_ID = "callId"
        private const val EXTRA_CALLER_NAME = "callerName"
        private const val EXTRA_CALLER_USERNAME = "callerUsername"
        private const val EXTRA_ACTION_TOKEN = "actionToken"
        private const val EXTRA_EXPIRES_AT = "expiresAt"

        fun intent(
            context: Context,
            callId: String,
            callerName: String,
            callerUsername: String,
            actionToken: String,
            expiresAt: Long?,
        ): Intent = Intent(context, IncomingCallActivity::class.java).apply {
            putExtra(EXTRA_CALL_ID, callId)
            putExtra(EXTRA_CALLER_NAME, callerName)
            putExtra(EXTRA_CALLER_USERNAME, callerUsername)
            putExtra(EXTRA_ACTION_TOKEN, actionToken)
            putExtra(EXTRA_EXPIRES_AT, expiresAt ?: 0L)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        }
    }
}
