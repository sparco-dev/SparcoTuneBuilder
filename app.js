const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs-extra');
const axios = require('axios');
const youtubesearchapi = require('youtube-search-api');
const youtubedl = require('youtube-dl-exec');
const ffmpeg = require('fluent-ffmpeg');
const { google } = require('googleapis');
const getAudioDurationInSeconds = require('get-audio-duration').getAudioDurationInSeconds;
const http = require('http');
const socketIO = require('socket.io');

// Spotify API credentials
const client_id = "391fea3fe1494a4d8890d696344805b7";
const client_secret = "578ed0eb2d0d41ba9617d18267717af8";
var spotifyUrl = "https://accounts.spotify.com/api/token";

const app = express();
const PORT = 3000;

// Creiamo il server HTTP
const server = http.createServer(app);

// Inizializziamo Socket.io
const io = socketIO(server);

// Configurazione per servire file statici e impostare EJS come motore di rendering
app.use(express.static('public'));
app.use('/exports', express.static(path.join(__dirname, 'exports')));
app.set('view engine', 'ejs');
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Funzione per cercare un video su YouTube in base al titolo
async function searchSongOnYouTube(query) {
    const results = await youtubesearchapi.GetListByKeyword(query, false);
    return results.items.map(item => ({
        id: item.id,
        title: item.title,
        thumbnailUrl: `https://img.youtube.com/vi/${item.id}/hqdefault.jpg`
    }));
}

// Funzione per inviare aggiornamenti di progresso tramite Socket.io
function sendProgressUpdate(socket, message) {
    if (socket) {
        socket.emit('progress', message);
    }
}

// Funzione per scaricare l'audio del video da YouTube
async function downloadAudio(videoUrl, outputFilePath) {
    return youtubedl(videoUrl, {
        output: outputFilePath,
        extractAudio: true,
        audioFormat: 'mp3'
    });
}

// Funzione per scaricare la miniatura in alta risoluzione
async function downloadThumbnail(videoId, outputFilePath) {
    const highResThumbnailUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
    const fallbackThumbnailUrl = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;

    try {
        const response = await axios({
            url: highResThumbnailUrl,
            responseType: 'stream'
        });
        response.data.pipe(fs.createWriteStream(outputFilePath));
        return new Promise((resolve, reject) => {
            response.data.on('end', () => resolve());
            response.data.on('error', reject);
        });
    } catch (error) {
        const response = await axios({
            url: fallbackThumbnailUrl,
            responseType: 'stream'
        });
        response.data.pipe(fs.createWriteStream(outputFilePath));
        return new Promise((resolve, reject) => {
            response.data.on('end', () => resolve());
            response.data.on('error', reject);
        });
    }
}

// Funzione per sanificare il titolo del video per l'utilizzo nei nomi di file
function sanitizeTitle(title) {
    return title.replace(/[^a-zA-Z0-9-_]/g, '_');  // Sostituisce caratteri non validi con _
}

// Funzione per modificare l'audio (pitch e velocità)
function modifyAudio(inputFile, outputFile, speedFactor, pitchFactor) {
    return new Promise((resolve, reject) => {
        const command = ffmpeg(inputFile);

        if (speedFactor !== 1.0 || pitchFactor !== 1.0) {
            // Applica i filtri solo se speedFactor o pitchFactor non sono 1
            command.audioFilters([
                `asetrate=44100*${pitchFactor}`,  // Modifica il pitch
                `atempo=${speedFactor}`           // Modifica la velocità
            ]);
        }

        command.save(outputFile)
            .on('end', resolve)
            .on('error', reject);
    });
}


// Funzione per creare il video con sfocatura gaussiana, testo e logo in basso, con sfondo blu o viola
function createVideo(ytThumbnail, spotifyCover, audioFile, outputFile, title, customText, speedFactor = 1.00, pitchFactor = 1.00, backgroundColor = 'blue') {
    return new Promise(async (resolve, reject) => {
        try {
            const audioDuration = await getAudioDurationInSeconds(audioFile);
            const fontFilePath = path.join(__dirname, 'fonts', 'SF-Pro-Display-Heavy.otf'); // Font for the custom text
            const logoFilePath = path.join(__dirname, 'logo', 'sparcodev.png'); // Path to your logo
            const watermarkFontFilePath = path.join(__dirname, 'fonts', 'SF-Pro-Display-Semibold.otf'); // Font for the watermark text

            // Definisci il colore di sfondo in base alla scelta dell'utente (blu o viola)
            const backgroundFilter = `color=${backgroundColor}@0.6:size=1920x1080:rate=25[bg_overlay]`;

            const ffmpegCommand = ffmpeg()
                .input(ytThumbnail)  // Input YouTube thumbnail (video)
                .loop(audioDuration)  // Loop the image for the duration of the audio
                .input(audioFile)     // Input audio
                .input(spotifyCover)  // Input Spotify album cover (video)
                .input(logoFilePath)  // Input logo (video)
                .complexFilter([
                    '[0:v]gblur=sigma=20[bg]',  // Apply Gaussian blur to YouTube thumbnail and call it 'bg'
                    backgroundFilter,  // Apply background overlay (blue or purple based on user selection)
                    '[bg][bg_overlay]overlay[bg_with_overlay]',  // Overlay the background
                    '[2:v]scale=350:350[cover]',  // Scale Spotify cover
                    '[bg_with_overlay][cover]overlay=(main_w-overlay_w)/2:80[bg_with_cover]',  // Overlay Spotify cover
                    `[bg_with_cover]drawtext=fontfile=${fontFilePath}:text='${customText}':fontcolor=#f9bc00:fontsize=35:x=(w-text_w)/2:y=490[bg_with_text]`,  // Add custom text
                    '[3:v]scale=35:35[logo]',  // Scale the logo
                    '[bg_with_text][logo]overlay=x=(W-w)/2:y=H-h-55[bg_with_logo]',  // Overlay logo at the bottom
                    `[bg_with_logo]drawtext=fontfile=${watermarkFontFilePath}:text='made with SparcoTuneBuilder':fontcolor=white:fontsize=20:x=(w-text_w)/2:y=H-40[final_output]`
                ])
                .outputOptions([
                    '-map', '[final_output]',  // Final video output
                    '-map', '1:a',  // Map the audio
                    '-shortest'  // Shorten the video to match the audio length
                ]);

            // Apply audio filters for pitch and speed if needed
            // if (pitchFactor !== 1.00) {
            //     ffmpegCommand.audioFilters(`asetrate=44100*${pitchFactor}`);
            // }

            // if (speedFactor !== 1.00) {
            //     ffmpegCommand.audioFilters(`atempo=${speedFactor}`);
            // }

            ffmpegCommand
            .on('start', function(commandLine) {
                console.log('FFmpeg command started:', commandLine);
            })
            .on('end', function() {
                console.log('Video processing finished.');
                resolve();
            })
            .on('error', function(err, stdout, stderr) {
                console.error('Error:', err);
                reject(err);
            })
            .save(outputFile);
        } catch (error) {
            console.error('Error during video creation:', error);
            reject(error);
        }
    });
}

// Endpoint per cercare video su YouTube in base al titolo
app.get('/search', async (req, res) => {
    const query = req.query.query;
    try {
        const results = await youtubesearchapi.GetListByKeyword(query, false);
        const formattedResults = results.items.map(item => ({
            id: item.id,
            title: item.title,
            description: item.description, // Aggiungi altri dettagli se necessari
            thumbnailUrl: `https://img.youtube.com/vi/${item.id}/hqdefault.jpg`
        }));
        res.json({ results: formattedResults });
    } catch (error) {
        res.status(500).json({ error: 'Errore durante la ricerca' });
    }
});

// Endpoint per scaricare l'audio e la miniatura
app.post('/download-and-modify', async (req, res) => {
    const videoId = req.body.videoId;
    const videoTitle = req.body.videoTitle;
    const sanitizedTitle = sanitizeTitle(videoTitle);  // Sanifica il titolo
    const thumbnailUrl = req.body.videoThumbnailUrl;
    const socketId = req.body.socketId;

    if (!videoId || !videoTitle || !thumbnailUrl) {
        return res.status(400).send('Dati video mancanti');
    }

    const socket = io.sockets.sockets.get(socketId);

    try {
        const songFolder = path.join(__dirname, 'exports', sanitizedTitle);
        await fs.ensureDir(songFolder);

        const audioFilePath = path.join(songFolder, 'audio.mp3');
        const thumbnailFilePath = path.join(songFolder, 'thumbnail.jpg');

        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

        sendProgressUpdate(socket, 'Scaricamento audio in corso...');
        await downloadAudio(videoUrl, audioFilePath);

        sendProgressUpdate(socket, 'Scaricamento miniatura in corso...');
        await downloadThumbnail(videoId, thumbnailFilePath);

        res.json({ success: true });
    } catch (error) {
        console.error('Errore durante il download dell\'audio o della miniatura:', error);
        sendProgressUpdate(socket, 'Errore durante il download dell\'audio o della miniatura.');
        res.json({ success: false });
    }
});

// Route per creare il video (POST /create-video)
app.post('/create-video', async (req, res) => {
    const videoTitle = req.body.videoTitle;
    const sanitizedTitle = sanitizeTitle(videoTitle);  // Sanitize the title
    const customText = req.body.customText;
    const speedFactor = req.body.speedFactor;
    const pitchFactor = req.body.pitchFactor;
    const backgroundColor = req.body.backgroundColor || 'blue';  // Set default background color to blue
    const socketId = req.body.socketId;

    const socket = io.sockets.sockets.get(socketId);

    try {
        if (!spotifyAccessToken) {
            await generateToken();  // Generate token if it's not already available
        }

        const songFolder = path.join(__dirname, 'exports', sanitizedTitle);
        await fs.ensureDir(songFolder);

        const audioFilePath = path.join(songFolder, 'audio.mp3');
        const modifiedAudioFilePath = path.join(songFolder, 'audio_modified.mp3');
        const thumbnailFilePath = path.join(songFolder, 'thumbnail.jpg');
        const spotifyCoverFilePath = path.join(songFolder, 'spotify_cover_selected.jpg'); // Usa la copertina selezionata dall'utente
        const outputVideoPath = path.join(songFolder, 'output_video.mp4');

        sendProgressUpdate(socket, 'Modifying audio...');
        await modifyAudio(audioFilePath, modifiedAudioFilePath, speedFactor, pitchFactor);

        sendProgressUpdate(socket, 'Checking Spotify album cover...');

        // Verifica se la copertina esiste già
        if (!fs.existsSync(spotifyCoverFilePath)) {
            // Se non esiste, scarica la copertina da Spotify
            await downloadSpotifyCover(videoTitle, spotifyCoverFilePath);
        } else {
            console.log('Spotify cover already exists. Using the existing cover.');
        }

        sendProgressUpdate(socket, 'Creating video...');
        await createVideo(thumbnailFilePath, spotifyCoverFilePath, modifiedAudioFilePath, outputVideoPath, videoTitle, customText, speedFactor, pitchFactor, backgroundColor); // Pass background color

        sendProgressUpdate(socket, 'Video created successfully.');

        socket.emit('videoCompleted', {
            videoUrl: `/exports/${sanitizedTitle}/output_video.mp4`,
            videoTitle
        });
    } catch (error) {
        console.error('Error during video creation:', error);
        sendProgressUpdate(socket, 'Error during video creation.');
        res.status(500).send('Error during video creation.');
    }
});


let spotifyAccessToken = null;
let spotifyTokenExpiry = null;

function isTokenExpired() {
    return !spotifyTokenExpiry || Date.now() > spotifyTokenExpiry;
}

function generateToken() {
    if (!isTokenExpired()) return Promise.resolve(); // No need to generate a new token

    return fetch(spotifyUrl, {
        method: "POST",
        headers: {
            Authorization: "Basic " + Buffer.from(`${client_id}:${client_secret}`).toString('base64'),
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ grant_type: "client_credentials" }),
    })
    .then((response) => response.json())
    .then((tokenResponse) => {
        spotifyAccessToken = tokenResponse.access_token;
        spotifyTokenExpiry = Date.now() + (tokenResponse.expires_in * 1000); // Set expiry time
        console.log("Spotify token saved successfully");
    })
    .catch((error) => {
        console.error("Error generating Spotify token:", error);
    });
}

// Function to search Spotify track and retrieve album cover
function searchSpotify(query, accessToken) {
    return fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=album,track&limit=5`, {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
    })
    .then((response) => response.json())
    .then((data) => {
        const results = [];

        if (data.albums && data.albums.items.length > 0) {
            data.albums.items.forEach(album => {
                results.push({
                    coverUrl: album.images[0].url,
                    title: `Album: ${album.name}`,
                    id: album.id
                });
            });
        }

        if (data.tracks && data.tracks.items.length > 0) {
            data.tracks.items.forEach(track => {
                results.push({
                    coverUrl: track.album.images[0].url,
                    title: `Track: ${track.name} - ${track.artists[0].name}`,
                    id: track.id
                });
            });
        }

        return results;
    });
}

app.get('/search-spotify', async (req, res) => {
    const query = req.query.query;
    
    try {
        if (!spotifyAccessToken) {
            await generateToken();
        }
        
        const results = await searchSpotify(query, spotifyAccessToken);
        res.json({ results });
    } catch (error) {
        res.status(500).json({ error: 'Errore durante la ricerca su Spotify' });
    }
});

// Function to download Spotify album cover
async function downloadSpotifyCover(trackName, outputFilePath) {
    if (!spotifyAccessToken) {
        console.error('Spotify Access Token not found');
        return;
    }

    // Usa la funzione searchSpotify per cercare tracce o album su Spotify
    const results = await searchSpotify(trackName, spotifyAccessToken);

    // Prendi la copertina della prima traccia o album trovato
    const spotifyCoverUrl = results.length > 0 ? results[0].coverUrl : null;

    if (spotifyCoverUrl) {
        try {
            const response = await axios({
                url: spotifyCoverUrl,
                responseType: 'stream',
            });
            response.data.pipe(fs.createWriteStream(outputFilePath));
            return new Promise((resolve, reject) => {
                response.data.on('end', resolve);
                response.data.on('error', reject);
            });
        } catch (error) {
            console.error('Error downloading Spotify cover:', error);
        }
    } else {
        console.error('No Spotify cover found for track:', trackName);
    }
}

// Endpoint per scaricare una copertina da Spotify
app.post('/download-cover', async (req, res) => {
    const coverUrl = req.body.coverUrl;
    const songTitle = sanitizeTitle(req.body.songTitle); // Usa il titolo della canzone per creare il nome della cartella
    const coverPath = path.join(__dirname, 'exports', songTitle, 'spotify_cover_selected.jpg'); // Salva nella cartella della canzone

    try {
        const response = await axios({
            url: coverUrl,
            responseType: 'stream',
        });
        response.data.pipe(fs.createWriteStream(coverPath));
        return new Promise((resolve, reject) => {
            response.data.on('end', () => {
                res.json({ success: true, coverPath: `/exports/${songTitle}/spotify_cover_selected.jpg` });
            });
            response.data.on('error', reject);
        });
    } catch (error) {
        console.error('Errore durante il download della copertina:', error);
        res.status(500).json({ error: 'Errore durante il download della copertina.' });
    }
});

const CLIENT_ID = '272667372717-29154ii9smo4eddb4tdom115rbs00n0g.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const REDIRECT_URI = 'http://localhost:3000/oauth2callback';
const TOKEN_PATH = 'path_to_stored_token.json';
const SCOPES = ['https://www.googleapis.com/auth/youtube.upload'];

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

function loadToken() {
    return new Promise((resolve, reject) => {
      fs.readFile(TOKEN_PATH, (err, token) => {
        if (err) {
          reject('Token not found');
        } else {
          resolve(JSON.parse(token));
        }
      });
    });
  }

  function saveToken(token) {
    fs.writeFile(TOKEN_PATH, JSON.stringify(token), (err) => {
        if (err) {
            console.error('Errore durante il salvataggio del token:', err);
        } else {
            console.log('Token salvato correttamente in', TOKEN_PATH);
        }
    });
}

  async function ensureValidToken() {
    const token = await loadToken();
    oauth2Client.setCredentials(token);
    if (!token || oauth2Client.credentials.expiry_date <= Date.now()) {
      console.log('Token expired, refreshing...');
      const { credentials } = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(credentials);
      saveToken(credentials);
    }
  }

// Rotta per iniziare il processo OAuth2
app.get('/oauth2', (req, res) => {
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
    });
    res.redirect(authUrl);
  });
  
  app.get('/oauth2callback', async (req, res) => {
    const code = req.query.code;
    try {
      const { tokens } = await oauth2Client.getToken(code);
      oauth2Client.setCredentials(tokens);
      saveToken(tokens); // Save token for future use
      res.redirect('/');
    } catch (error) {
      console.error('Errore durante l\'autenticazione:', error);
      res.status(500).send('Errore durante l\'autenticazione');
    }
  });

// Callback dopo l'autenticazione OAuth2
app.get('/oauth2callback', async (req, res) => {
    const code = req.query.code;
    try {
      const { tokens } = await oauth2Client.getToken(code);  // Ottieni il token
      oauth2Client.setCredentials(tokens);  // Salva il token nelle credenziali OAuth2
  
      // Se c'è un refresh_token, salvalo per usi futuri
      if (tokens.refresh_token) {
        // Salva il refresh token in una variabile globale o in un file per un uso successivo
        spotifyAccessToken = tokens.refresh_token;
      }
  
      res.redirect('/'); // Reindirizza alla pagina principale dopo l'autenticazione
    } catch (error) {
      console.error('Errore durante il processo di autenticazione:', error);
      res.status(500).send('Errore durante il processo di autenticazione');
    }
  });

// Rotta principale per rendere l'index.ejs e passare il percorso del video generato
app.get('/', (req, res) => {
  const videoPath = '/exports/your_dynamic_video/output_video.mp4'; // Calcola dinamicamente il percorso
  res.render('index', { videoPath }); // Passa la variabile videoPath a EJS
});

// Funzione per caricare il video su YouTube
async function uploadToYouTube(auth, videoPath, title, description, tags, privacy) {
    const youtube = google.youtube({ version: 'v3', auth });
  
    const fileSize = fs.statSync(videoPath).size;
  
    try {
      await ensureValidToken(); // Ensure the token is valid before upload
  
      console.log(`Inizio il caricamento del video: ${title}`);
  
      const response = await youtube.videos.insert({
        part: 'snippet,status',
        requestBody: {
          snippet: {
            title: title,
            description: description,
            tags: tags,
          },
          status: {
            privacyStatus: privacy,
          },
        },
        media: {
          body: fs.createReadStream(videoPath),
        },
      }, {
        onUploadProgress: (evt) => {
          const progress = (evt.bytesRead / fileSize) * 100;
          console.log(`${Math.round(progress)}% completato`);
        },
      });
  
      console.log('Video caricato con successo:', response.data);
      return response.data;
    } catch (error) {
      console.error('Errore durante il caricamento su YouTube:', error.response ? error.response.data : error.message);
      throw error;
    }
  }

// Rotta per gestire la richiesta di pubblicazione del video
app.post('/publish-video', async (req, res) => {
    const { videoPath, title, description, tags, privacy, socketId } = req.body;

    console.log('Richiesta di pubblicazione ricevuta:', req.body);

    if (!videoPath || !title || !description || !tags || !privacy || !socketId) {
      console.error('Dati mancanti per la pubblicazione del video.');
      return res.status(400).send('Missing data for video publishing.');
    }

    const socket = io.sockets.sockets.get(socketId);

    if (!socket) {
      console.error('Socket non trovato o non valido.');
      return res.status(400).send('Invalid or missing socket.');
    }

    try {
      // Check if the token has expired and refresh if necessary
      if (!oauth2Client.credentials || oauth2Client.credentials.expiry_date <= Date.now()) {
        console.log('Token scaduto, aggiornamento in corso...');
        const { credentials } = await oauth2Client.refreshAccessToken();
        oauth2Client.setCredentials(credentials);
      }

      const absoluteVideoPath = path.join(__dirname, videoPath); 

      const videoData = await uploadToYouTube(oauth2Client, absoluteVideoPath, title, description, tags, privacy);

      console.log(`Caricamento completato per il video: ${title}`);
      socket.emit('videoCompleted', {
        videoUrl: `/exports/${sanitizeTitle(title)}/output_video.mp4`,
        videoTitle: title,
        videoPath: absoluteVideoPath 
      });

      res.json({ success: true, videoData });
    } catch (error) {
      console.error('Error during video publishing:', error);
      res.status(500).json({ error: 'Error during video publishing on YouTube.' });
    }
});


// Add Genius API credentials
const geniusClientID = 'E88hry4fq6JePwbjYDp-4tbat5Uai0k7nVZBm_5br6QYC_bhBgE83Pe93d1U4TYY';
const geniusClientSecret = 'sY-oksUUvf637fNd3_ezzRgblVK5a5KZ3mmPILyJvTLwNv5O1SvxiqYKPG8ATUg1MgjFcADrr1rUjYPALWmIRw';
const geniusAccessToken = 'DUgBbAQBxcd5SbySElXiOE65RraCLz1i55j1yh0s6LZOHgMfZ2VslBY9d7IC0iRl';

// Function to search for lyrics via Genius API
async function searchLyricsOnGenius(songTitle) {
    const apiUrl = `https://api.genius.com/search?q=${encodeURIComponent(songTitle)}`;
    
    try {
        const response = await axios.get(apiUrl, {
            headers: {
                'Authorization': `Bearer ${geniusAccessToken}`
            }
        });

        if (response.data.response.hits.length > 0) {
            const songInfo = response.data.response.hits[0].result;
            const lyricsUrl = songInfo.url;
            
            // Return the song title and lyrics URL
            return {
                title: songInfo.full_title,
                url: lyricsUrl
            };
        } else {
            return null;
        }
    } catch (error) {
        console.error('Error fetching lyrics from Genius:', error);
        return null;
    }
}

// Endpoint to get song lyrics for a given song title
app.get('/get-lyrics', async (req, res) => {
    const songTitle = req.query.songTitle;
    
    try {
        const lyricsData = await searchLyricsOnGenius(songTitle);
        if (lyricsData) {
            res.json({
                success: true,
                lyrics: lyricsData
            });
        } else {
            res.json({ success: false, message: 'Lyrics not found' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching lyrics' });
    }
});

// Configura Socket.IO per il tempo reale
io.on('connection', (socket) => {
  console.log('Nuovo client connesso:', socket.id);

  socket.on('disconnect', () => {
    console.log('Client disconnesso:', socket.id);
  });
});

// Render della pagina principale
app.get('/', (req, res) => {
    res.render('index');
});

// Avvio del server
server.listen(PORT, () => {
    console.log(`Server in esecuzione su http://localhost:${PORT}`);
});

