from flask import Flask, render_template

app = Flask(__name__)


@app.route('/')
def home():
    return render_template('home.html')


@app.route('/gpx_editor')
def gpx_editor():
    return render_template('gpx_editor.html')


@app.route('/strava_archive')
def strava_archive():
    return render_template('strava_archive.html')


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5052, debug=False)
