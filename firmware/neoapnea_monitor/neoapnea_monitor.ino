/*
 * NeoApnea Monitor firmware: an open-source apnea monitor for preterm infants.
 *
 * Reads chest movement from an accelerometer and a pulse (PPG) signal from a
 * pulse oximeter, and streams both over USB serial to the NeoApnea Monitor
 * app, which plots them and runs the apnea, heart-rate and SpO2 alarms.
 *
 * Board: Arduino Mega 2560 (ATmega2560).
 *
 * Wiring: both sensors share the I2C bus, SDA on pin 20 and SCL on pin 21.
 *   MPU-6050 accelerometer (GY-521 breakout), address 0x68, on the chest.
 *   MAX30102 pulse oximeter, address 0x57, on a finger.
 *
 * Libraries (Arduino Library Manager):
 *   "MPU6050" by Electronic Cats                             -> MPU6050.h
 *   "SparkFun MAX3010x Pulse and Proximity Sensor Library"   -> MAX30105.h, spo2_algorithm.h
 *
 * Sampling:
 *   Accelerometer: only the z axis is used. Timer1 sets a flag 10 times per
 *   second (16 MHz / 256 / 6250) and the loop reads the sensor on each flag.
 *   A frame carries the latest two readings, so the stream holds 8
 *   accelerometer samples per second.
 *   Pulse oximeter: red and infrared at 200 Hz with 2-sample averaging,
 *   100 samples per second.
 *
 * Serial output at 57600 baud:
 *   Buffer: 1, az0, az1, red0, ..., red24, 1    every 0.25 s, 29 values;
 *                                               the first and last are 1,
 *                                               start and end markers
 *   SPO2= <value>, <valid>                      after every 100 PPG samples;
 *                                               valid is 1 or 0
 * Lines that start with anything else are status messages; the app ignores them.
 *
 * Known limitations:
 *   SparkFun's maxim_heart_rate_and_oxygen_saturation() assumes 25 samples
 *   per second (FreqS in spo2_algorithm.h), but it is given 100 samples taken
 *   at 100 Hz, so treat the SpO2 it returns as unvalidated.
 *   Red and infrared samples are stored as 16-bit int, so readings must stay
 *   below 32768 to arrive unchanged.
 */

#include "Wire.h"
#include "MPU6050.h"
#include "MAX30105.h"
#include "spo2_algorithm.h"

MPU6050 accelerometer;
MAX30105 oximeter;

const int PPG_PER_FRAME = 25;              // red samples in one frame, 0.25 s at 100 Hz
const int ACC_PER_FRAME = 2;               // accelerometer samples in one frame
const int FRAME_LENGTH = 1 + ACC_PER_FRAME + PPG_PER_FRAME + 1;
const int SPO2_WINDOW = 100;               // samples per SpO2 estimate

volatile bool accelerometerDue = false;    // set by the Timer1 interrupt

int frame[FRAME_LENGTH];                   // start marker, z-axis samples, red samples, end marker

int accSamples[ACC_PER_FRAME];
int accCount = 0;
bool accReady = false;

int redSamples[PPG_PER_FRAME];
int ppgCount = 0;
bool ppgReady = false;

uint32_t redWindow[SPO2_WINDOW];
uint32_t irWindow[SPO2_WINDOW];
int windowCount = 0;

int32_t spo2;
int8_t spo2Valid;
int32_t heartRate;       // also computed by the SparkFun algorithm; not sent
int8_t heartRateValid;

void setup() {
  Serial.begin(57600);
  Wire.begin();
  accelerometer.initialize();
  oximeter.begin();

  // Timer1 in CTC mode with a 256 prescaler: compare match every
  // 6250 ticks, 16 MHz / (256 * 6250) = 10 Hz.
  cli();
  TCCR1A = 0;
  TCCR1B = 0;
  TCNT1 = 0;
  OCR1A = 6249;
  TCCR1B |= (1 << WGM12);    // CTC mode
  TCCR1B |= (1 << CS12);     // prescaler 256
  TIMSK1 |= (1 << OCIE1A);   // enable the compare A interrupt
  sei();

  if (accelerometer.testConnection()) {
    Serial.println("Accelerometer ready");
  } else {
    Serial.println("Accelerometer not found");
  }
  if (oximeter.begin() == false) {
    Serial.println("Pulse oximeter not found");
  } else {
    Serial.println("Pulse oximeter ready");
  }

  byte ledBrightness = 60;   // 0 = off to 255 = 50 mA
  byte sampleAverage = 2;    // 1, 2, 4, 8, 16 or 32
  byte ledMode = 2;          // 1 = red only, 2 = red + IR, 3 = red + IR + green
  byte sampleRate = 200;     // 50, 100, 200, 400, 800, 1000, 1600 or 3200
  int pulseWidth = 69;       // 69, 118, 215 or 411 us
  int adcRange = 4096;       // 2048, 4096, 8192 or 16384
  oximeter.setup(ledBrightness, sampleAverage, ledMode, sampleRate, pulseWidth, adcRange);

  frame[0] = 1;
  frame[FRAME_LENGTH - 1] = 1;
}

void loop() {
  if (accelerometerDue) {
    int16_t ax, ay, az;
    accelerometer.getAcceleration(&ax, &ay, &az);
    accSamples[accCount] = az;
    accCount++;
    if (accCount == ACC_PER_FRAME) {
      for (int i = 0; i < ACC_PER_FRAME; i++) {
        frame[1 + i] = accSamples[i];
      }
      accCount = 0;
      accReady = true;
    }
    accelerometerDue = false;
  }

  oximeter.check();
  while (oximeter.available()) {
    redSamples[ppgCount] = oximeter.getFIFORed();
    redWindow[windowCount] = redSamples[ppgCount];
    // Through int, like the red samples, so the SpO2 estimate sees 16-bit values.
    irWindow[windowCount] = (int)oximeter.getFIFOIR();
    ppgCount++;
    windowCount++;
    oximeter.nextSample();

    if (ppgCount == PPG_PER_FRAME) {
      for (int i = 0; i < PPG_PER_FRAME; i++) {
        frame[1 + ACC_PER_FRAME + i] = redSamples[i];
      }
      ppgCount = 0;
      ppgReady = true;
    }

    if (windowCount == SPO2_WINDOW) {
      maxim_heart_rate_and_oxygen_saturation(irWindow, SPO2_WINDOW, redWindow, &spo2, &spo2Valid,
                                             &heartRate, &heartRateValid);
      windowCount = 0;
      Serial.print(F("SPO2= "));
      Serial.print(spo2, DEC);
      Serial.print(", ");
      Serial.println(spo2Valid, DEC);
    }
  }

  if (accReady && ppgReady) {
    Serial.print("Buffer: ");
    for (int i = 0; i < FRAME_LENGTH; i++) {
      Serial.print(frame[i]);
      if (i < FRAME_LENGTH - 1) {
        Serial.print(", ");
      }
    }
    Serial.println();
    accReady = false;
    ppgReady = false;
  }
}

ISR(TIMER1_COMPA_vect) {
  accelerometerDue = true;
}
