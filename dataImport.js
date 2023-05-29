require('dotenv').config();
const axios = require('axios');
const mongoose = require('mongoose');

//axios cache control
axios.defaults.headers.common['Cache-Control'] = 'no-cache';
axios.defaults.headers.common['Pragma'] = 'no-cache';
axios.defaults.headers.common['Expires'] = '0';

// Get GitHub repository and file name from environment variables
let githubRepository = process.env.GITHUB_REPOSITORY;
let githubFileName = process.env.GITHUB_FILE_NAME;
const mongoURI = process.env.MONGO_URI;



// MongoDB connection
mongoose.connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true });
const db = mongoose.connection;
db.on('error', console.error.bind(console, 'MongoDB connection error:'));
db.once('open', () => {
  console.log('Connected to MongoDB');
});

// Define schema for PII data
const piiSchema = new mongoose.Schema({
  name: String,
  regexPattern: String,
  sensitive: Boolean,
  onKey: Boolean
},{ strict: false });

// Define model for PII data
const PiiModel = mongoose.model('Pii', piiSchema);

// Fetch data from GitHub and store it in MongoDB
const fetchDataFromGitHub = async () => {
  try {
    const githubApiUrl = `https://api.github.com/repos/${githubRepository}/contents`;
    const response = await axios.get(githubApiUrl);

    if (response.status !== 200) {
      throw new Error('Failed to fetch data from GitHub');
    }

    const files = response.data;
    let file = findFileByName(files, githubFileName);

    //handling file renaming in github (the code will consider any file that has a different name than the original githubFileName and ends with githubFileName in its path as a potential renamed file. )
    if (!file) {
      const renamedFile = files.find(file => file.name !== githubFileName && file.path.endsWith(githubFileName));

      if (!renamedFile) {
        throw new Error('File not found in the repository');
      }

      githubFileName = renamedFile.name;
      file = renamedFile;
    }

    const fileUrl = file.download_url;

    const fileResponse = await axios.get(fileUrl);

    if (fileResponse.status !== 200) {
      throw new Error('Failed to fetch file content from GitHub');
    }

    const data = fileResponse.data;

    if (!Array.isArray(data.types)) {
      throw new Error('Invalid data format');
    }

    // Get existing documents from the collection 
    const existingDocuments = await PiiModel.find({});

    // Find new entries and updates
    const newEntries = data.types.filter(newEntry => {
      return !existingDocuments.some(existingEntry => existingEntry.name === newEntry.name);
    });

    const updatedEntries = data.types.filter(updatedEntry => {
      return existingDocuments.some(existingEntry => existingEntry.name === updatedEntry.name);
    });

    // Delete documents for deleted entries
    const deletedEntries = existingDocuments.filter(existingEntry => {
      return !data.types.some(newEntry => newEntry.name === existingEntry.name);
    });

    for (const deletedEntry of deletedEntries) {
      await PiiModel.deleteOne({ _id: deletedEntry._id });
    }

    // Insert documents for new entries
    for (const newEntry of newEntries) {
      const entry = new PiiModel(newEntry);
      await entry.save();
    }

    // Update documents of the existing entries
    for (const updatedEntry of updatedEntries) {
      const existingEntry = existingDocuments.find(existingEntry => existingEntry.name === updatedEntry.name);
      existingEntry.regexPattern = updatedEntry.regexPattern;
      existingEntry.sensitive = updatedEntry.sensitive;
      existingEntry.onKey = updatedEntry.onKey;
      await existingEntry.save();
    }
    

    console.log('Data imported successfully.');
  } catch (error) {
    console.error('Error fetching data from GitHub:', error.message);
  }
};


const findFileByName = (files, fileName) => {
  for (const file of files) {
    if (file.type === 'file' && file.name === fileName) {
      return file;
    } else if (file.type === 'dir' && file.children) {
      const childFile = findFileByName(file.children, fileName);
      if (childFile) {
        return childFile;
      }
    }
  }

  return null;
};

// Run the data import cron periodically
const interval=24*60*60 * 1000; //Set the interval for cron job
const runCron = () => {
  fetchDataFromGitHub();
  setInterval(fetchDataFromGitHub,interval);
};
runCron();

