// MongoDB initialization script for production
db = db.getSiblingDB('myrotapro_prod');

// Create application user
db.createUser({
  user: 'myrotapro_user',
  pwd: 'myrotapro_password',
  roles: [
    {
      role: 'readWrite',
      db: 'myrotapro_prod'
    }
  ]
});

// Create initial collections with indexes
db.createCollection('users');
db.createCollection('homes');
db.createCollection('services');
db.createCollection('shifts');
db.createCollection('rotas');
db.createCollection('availability');
db.createCollection('timeoffrequests');
db.createCollection('weeklyschedules');
db.createCollection('shiftswaps');
db.createCollection('timetables');
db.createCollection('constraintweights');

// Create indexes for better performance
db.users.createIndex({ email: 1 }, { unique: true });
db.users.createIndex({ home_ids: 1 });
db.users.createIndex({ role: 1 });

db.homes.createIndex({ name: 1 });
db.homes.createIndex({ is_active: 1 });

db.services.createIndex({ home_id: 1 });
db.services.createIndex({ name: 1 });

db.shifts.createIndex({ home_id: 1, date: 1 });
db.shifts.createIndex({ user_id: 1, date: 1 });
db.shifts.createIndex({ service_id: 1 });

db.rotas.createIndex({ home_id: 1, week_start_date: 1 });
db.rotas.createIndex({ status: 1 });

db.availability.createIndex({ user_id: 1, date: 1 });
db.availability.createIndex({ date: 1 });

db.timeoffrequests.createIndex({ user_id: 1, start_date: 1 });
db.timeoffrequests.createIndex({ home_id: 1, status: 1 });

db.weeklyschedules.createIndex({ home_id: 1 });

db.shiftswaps.createIndex({ requester_id: 1, status: 1 });
db.shiftswaps.createIndex({ responder_id: 1, status: 1 });

db.timetables.createIndex({ home_id: 1, status: 1 });

print('Database initialization completed successfully');

