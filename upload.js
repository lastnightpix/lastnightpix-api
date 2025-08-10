const AWS = require('aws-sdk');
const fs = require('fs');
const path = require('path');

// Load environment variables from .env
require('dotenv').config();

// Constants — change if needed
const BUCKET = "practicelastnightpix";
const COLLECTION_ID = "my-face-collection";
const IMAGE_FILE = "myface.jpg"; // make sure this file is in the same folder

// Create AWS clients with region and credentials
const rekognition = new AWS.Rekognition({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION || 'us-east-2'
});

const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION || 'us-east-2'
});

async function uploadAndIndex() {
  try {
    const imagePath = path.join(__dirname, IMAGE_FILE);
    const imageData = fs.readFileSync(imagePath);

    // Upload to S3
    await s3.putObject({
      Bucket: BUCKET,
      Key: IMAGE_FILE,
      Body: imageData,
      ContentType: 'image/jpeg'
    }).promise();

    console.log(`✅ Uploaded ${IMAGE_FILE} to S3.`);

    // Index the face with Rekognition
    const result = await rekognition.indexFaces({
      CollectionId: COLLECTION_ID,
      Image: {
        S3Object: {
          Bucket: BUCKET,
          Name: IMAGE_FILE
        }
      },
      ExternalImageId: IMAGE_FILE,
      DetectionAttributes: []
    }).promise();

    if (result.FaceRecords.length > 0) {
      console.log(`🎉 Face indexed! FaceId: ${result.FaceRecords[0].Face.FaceId}`);
    } else {
      console.log("⚠️ No face detected in the image.");
    }

  } catch (err) {
    console.error("❌ Error uploading/indexing:", err.message);
  }
}

uploadAndIndex();
