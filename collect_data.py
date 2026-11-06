import serial
import time
import csv
from datetime import datetime

arduino = serial.Serial("COM4", 9600, timeout=1)

time.sleep(2)

print("Connected to Arduino")
print("Collecting temperature data...")
print("Press CTRL+C to stop.")

with open("weather_data.csv", "a", newline="") as file:

    writer = csv.writer(file)

    # Create header if file is empty
    if file.tell() == 0:
        writer.writerow(["timestamp", "temperature"])

    while True:

        line = arduino.readline().decode(
            "utf-8",
            errors="ignore"
        ).strip()

        if line:

            try:
                temperature = float(line)

                timestamp = datetime.now().strftime(
                    "%Y-%m-%d %H:%M:%S"
                )

                writer.writerow([
                    timestamp,
                    temperature
                ])

                file.flush()

                print(
                    f"{timestamp} | "
                    f"Temperature: {temperature} °C"
                )

            except ValueError:
                print("Invalid data:", line)